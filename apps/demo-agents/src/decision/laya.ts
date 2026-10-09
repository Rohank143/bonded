import { z } from "zod";
import {
  SENTINEL_QUESTIONS,
  type SentinelInput,
  type SentinelQuestionSet,
  sentinelQuestions,
  sentinelState,
} from "@bondedhq/shared";
import { mergeUsage, type ModelUsage } from "../usage.js";
import {
  type Decision,
  type DecisionModel,
  type DecisionQuestion,
  type DecisionOptions,
  allowedAnswers,
} from "./model.js";

/**
 * Sentinel models (docs/SPECIFICATION.md Section 10, docs/SENTINEL.md): something that answers the three
 * Sentinel questions about one proposed action. Laya answers all three in one forward pass;
 * an LLM stands in or double-checks. The guard only depends on `SentinelModel`.
 */

export type ActionRisk = keyof (typeof SENTINEL_QUESTIONS)["action_risk"]["criteria"];
export const ACTION_RISKS = Object.keys(SENTINEL_QUESTIONS.action_risk.criteria) as ActionRisk[];

/** What Sentinel sees: minimal context, in separate fields (specification Section 10.2). */
export interface SentinelFields {
  mandate: string;
  proposedAction: { tool: string; args: unknown };
  untrustedInputs: readonly SentinelInput[];
}

export interface SentinelAssessment {
  /** Probability the action is driven by untrusted content rather than the mandate. */
  manipulated: number;
  /**
   * The model's own action-risk answer. Absent for a v3 checkpoint, which isn't asked: the guard
   * computes within-mandate or breach in code instead (SentinelQuestionSet).
   */
  actionRisk?: { answer: ActionRisk; probabilities: Record<ActionRisk, number> };
  /**
   * Probability the untrusted inputs carry instructions aimed at the agent. Laya answers it in
   * the same pass for free; the LLM path skips it, since the guard doesn't block on it.
   */
  injection?: number;
  /** Which model produced this answer (after any escalation). */
  model: string;
  latencyMs: number;
  /** Set by `CascadeSentinel` when the primary model was unsure and the fallback answered. */
  escalated?: boolean;
  /** Set by `CascadeSentinel`: the primary model's own time, kept when the fallback answers. */
  primaryLatencyMs?: number;
  /** Set by `CascadeSentinel` on escalation: the fallback's own time. `latencyMs` is the sum. */
  fallbackLatencyMs?: number;
  /** This check's usage, independent of concurrent checks on the same model. */
  usage?: ModelUsage;
}

export interface SentinelAssessOptions {
  signal?: AbortSignal;
  onUsage?: (usage: ModelUsage) => void;
}

/** Missing provider cost stays unknown even when that response omitted token counts too. */
function checkUsage(parts: (ModelUsage | undefined)[]): ModelUsage | undefined {
  const present = parts.filter((p): p is ModelUsage => p !== undefined);
  const usage = mergeUsage(...present);
  if (usage && present.some((p) => p.costUsd === undefined)) delete usage.costUsd;
  return usage;
}

/** Path metadata survives an error; the API never stores the underlying error text. */
export class SentinelAssessmentError extends Error {
  constructor(
    cause: unknown,
    readonly metrics: Pick<
      SentinelAssessment,
      "escalated" | "primaryLatencyMs" | "fallbackLatencyMs"
    >,
  ) {
    super("Sentinel assessment failed", { cause });
    this.name = cause instanceof Error ? cause.name : "Error";
  }
}

export interface SentinelModel {
  readonly name: string;
  readonly usage?: ModelUsage;
  assess(fields: SentinelFields, options?: SentinelAssessOptions): Promise<SentinelAssessment>;
}

const probability = z.number().min(0).max(1);
const NoulAnswer = z.object({ type: z.literal("noul"), noul: probability });
const ChoiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), probability),
});
/** The part of Laya's `/v1/systemone` response Sentinel relies on; anything else is ignored. */
const LayaResponse = z.object({
  answers: z.object({
    manipulated: NoulAnswer,
    action_risk: ChoiceAnswer.optional(),
    injection_in_inputs: NoulAnswer,
  }),
  usage: z.object({ input_tokens: z.number() }).partial().optional(),
});

function parseActionRisk(raw: z.infer<typeof ChoiceAnswer>) {
  const probabilities = Object.fromEntries(
    ACTION_RISKS.map((k) => [k, raw.probabilities[k] ?? 0]),
  ) as Record<ActionRisk, number>;
  const answer = raw.choice as ActionRisk;
  if (!ACTION_RISKS.includes(answer))
    throw new Error(`Laya answered action_risk "${answer}", not one of ${ACTION_RISKS.join(", ")}`);
  return { answer, probabilities };
}

export interface LayaOptions {
  /** Base URL of a Laya server (`laya-serve`, or services/sentinel), without a trailing slash. */
  url: string;
  /** The server's `LAYA_API_KEY`, sent as a bearer token. */
  apiKey?: string;
  /** Checkpoint name the server routes to (services/sentinel serves the fine-tune here). */
  model?: string;
  /** The questions the checkpoint was trained on (default v1: all three). */
  questions?: SentinelQuestionSet;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

async function postSystemOne(
  options: LayaOptions,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const response = await (options.fetch ?? fetch)(`${options.url}/v1/systemone`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok)
    throw new Error(
      `Laya server answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  return response.json();
}

/**
 * Sentinel on Laya: one request, all three questions, in exactly the state and question format
 * the fine-tune was trained on (`sentinelState`, `sentinelQuestions`).
 */
export class LayaSentinel implements SentinelModel {
  readonly name: string;
  private inputTokens = 0;

  constructor(private readonly options: LayaOptions) {
    this.name = `laya/${options.model ?? "typed-decisions"}`;
  }

  /** Laya runs on our own hardware: tokens are counted, cost is zero. */
  get usage(): ModelUsage {
    return { inputTokens: this.inputTokens, outputTokens: 0, costUsd: 0 };
  }

  async assess(
    fields: SentinelFields,
    { signal, onUsage }: SentinelAssessOptions = {},
  ): Promise<SentinelAssessment> {
    const started = performance.now();
    const raw = await postSystemOne(
      this.options,
      {
        state: sentinelState(fields),
        questions: sentinelQuestions(this.options.questions),
        model: this.options.model ?? "typed-decisions",
      },
      signal,
    );
    const parsed = LayaResponse.safeParse(raw);
    if (!parsed.success) throw new Error(`Laya response not understood: ${parsed.error.message}`);
    const { answers, usage } = parsed.data;
    this.inputTokens += usage?.input_tokens ?? 0;
    const checkUsage = { inputTokens: usage?.input_tokens ?? 0, outputTokens: 0, costUsd: 0 };
    onUsage?.(checkUsage);
    const asked = (this.options.questions ?? "v1") === "v1";
    if (asked && !answers.action_risk) throw new Error("Laya response has no action_risk answer");
    return {
      manipulated: answers.manipulated.noul,
      ...(asked ? { actionRisk: parseActionRisk(answers.action_risk!) } : {}),
      injection: answers.injection_in_inputs.noul,
      model: this.name,
      latencyMs: performance.now() - started,
      usage: checkUsage,
    };
  }
}

/**
 * Sentinel on a chat model, through the typed `DecisionModel` interface: three questions,
 * worded as in `SENTINEL_QUESTIONS`. A yes/no answer's confidence becomes the probability of
 * "yes" (or one minus it for "no").
 */
export class DecisionModelSentinel implements SentinelModel {
  readonly name: string;

  constructor(private readonly model: DecisionModel) {
    this.name = model.name;
  }

  get usage(): ModelUsage | undefined {
    return this.model.usage;
  }

  async assess(
    fields: SentinelFields,
    options: SentinelAssessOptions = {},
  ): Promise<SentinelAssessment> {
    const started = performance.now();
    const parts: ModelUsage[] = [];
    const decisionOptions = {
      signal: options.signal,
      onUsage: (usage: ModelUsage) => {
        parts.push(usage);
        options.onUsage?.(usage);
      },
    };
    const context = {
      mandate: fields.mandate,
      proposed_action: JSON.stringify(fields.proposedAction),
      untrusted_inputs:
        fields.untrustedInputs
          .map((i) => `${i.tool}: ${i.output}`)
          .join("\n")
          .slice(-6000) || "(none)",
    };
    const yes = async (key: "manipulated") => {
      const d = await this.model.decide(
        {
          type: "noul",
          key,
          instruction: `Is this statement true? ${SENTINEL_QUESTIONS[key].instructions}`,
          context,
        },
        decisionOptions,
      );
      return d.answer === "yes" ? d.confidence : 1 - d.confidence;
    };
    const manipulated = await yes("manipulated");
    const risk = await this.model.decide(
      {
        type: "choice",
        key: "action_risk",
        instruction: SENTINEL_QUESTIONS.action_risk.instructions,
        options: [...ACTION_RISKS],
        context,
      },
      decisionOptions,
    );
    if (!ACTION_RISKS.includes(risk.answer as ActionRisk))
      throw new Error(`${this.name} answered action_risk "${risk.answer}"`);
    const answer = risk.answer as ActionRisk;
    const rest = (1 - risk.confidence) / (ACTION_RISKS.length - 1);
    return {
      manipulated,
      actionRisk: {
        answer,
        probabilities: Object.fromEntries(
          ACTION_RISKS.map((k) => [k, k === answer ? risk.confidence : rest]),
        ) as Record<ActionRisk, number>,
      },
      model: this.name,
      latencyMs: performance.now() - started,
      usage: checkUsage(parts),
    };
  }
}

export interface CascadeOptions {
  /**
   * The primary model is "unsure" when its manipulated probability is inside this band, or its
   * top action-risk probability is below `minRiskConfidence`, or it calls the action a likely
   * breach (the guard doesn't block on that answer, so it gets a second opinion instead). Set these from the held-out
   * evaluation (issue #32); the defaults are a starting point, not a measured choice.
   */
  unsureBand?: [number, number];
  minRiskConfidence?: number;
}

/**
 * Laya first, a second model only when Laya is unsure (docs/BUSINESS.md, lever 1). The
 * escalation count is kept so the cost saving can be measured.
 */
/** The "manipulated" scores a cascade sends to its second model by default. */
export const DEFAULT_CASCADE_UNSURE_BAND: [number, number] = [0.25, 0.75];

/** Open band: scores equal to an endpoint do not escalate. */
export function validateCascadeOptions(options: CascadeOptions = {}) {
  const band = options.unsureBand ?? DEFAULT_CASCADE_UNSURE_BAND;
  const confidence = options.minRiskConfidence ?? 0.6;
  if (
    band.length !== 2 ||
    !band.every(Number.isFinite) ||
    band[0] < 0 ||
    band[1] > 1 ||
    band[0] >= band[1]
  )
    throw new Error("unsureBand must contain two increasing probabilities between 0 and 1");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    throw new Error("minRiskConfidence must be a probability between 0 and 1");
  return { unsureBand: [...band] as [number, number], minRiskConfidence: confidence };
}

export class CascadeSentinel implements SentinelModel {
  readonly name: string;
  checks = 0;
  escalations = 0;
  private readonly band: [number, number];
  private readonly minRiskConfidence: number;

  constructor(
    private readonly primary: SentinelModel,
    private readonly fallback: SentinelModel,
    options: CascadeOptions = {},
  ) {
    this.name = `cascade/${primary.name}+${fallback.name}`;
    const validated = validateCascadeOptions(options);
    this.band = validated.unsureBand;
    this.minRiskConfidence = validated.minRiskConfidence;
  }

  get usage(): ModelUsage | undefined {
    return this.fallback.usage;
  }

  unsure(a: SentinelAssessment): boolean {
    const [low, high] = this.band;
    if (a.manipulated > low && a.manipulated < high) return true;
    // A v3 model gives no action-risk answer; only its manipulated score can make it unsure.
    if (!a.actionRisk) return false;
    const topRisk = Math.max(...Object.values(a.actionRisk.probabilities));
    return topRisk < this.minRiskConfidence || a.actionRisk.answer === "breach_likely";
  }

  async assess(
    fields: SentinelFields,
    options: SentinelAssessOptions = {},
  ): Promise<SentinelAssessment> {
    this.checks++;
    const started = performance.now();
    let first: SentinelAssessment;
    try {
      first = await this.primary.assess(fields, options);
    } catch (cause) {
      throw new SentinelAssessmentError(cause, {
        escalated: false,
        primaryLatencyMs: performance.now() - started,
      });
    }
    if (!this.unsure(first))
      return { ...first, escalated: false, primaryLatencyMs: first.latencyMs };
    this.escalations++;
    const fallbackStarted = performance.now();
    let second: SentinelAssessment;
    try {
      second = await this.fallback.assess(fields, options);
    } catch (cause) {
      throw new SentinelAssessmentError(cause, {
        escalated: true,
        primaryLatencyMs: first.latencyMs,
        fallbackLatencyMs: performance.now() - fallbackStarted,
      });
    }
    return {
      ...second,
      latencyMs: first.latencyMs + second.latencyMs,
      primaryLatencyMs: first.latencyMs,
      fallbackLatencyMs: second.latencyMs,
      escalated: true,
      usage: checkUsage([first.usage, second.usage]),
    };
  }
}

/**
 * Any typed decision question on Laya (issue #12), for the decision-model trading agent. A
 * `noul` question is asked as a statement with `false`/`true` options, the way Laya's typed
 * decisions are trained; the answer maps back to "no"/"yes".
 */
export class LayaDecisionModel implements DecisionModel {
  readonly name: string;
  private inputTokens = 0;
  /** Round-trip time of each decision, in milliseconds (issue #12: latency is reported). */
  readonly latenciesMs: number[] = [];

  constructor(private readonly options: LayaOptions) {
    this.name = `laya/${options.model ?? "typed-decisions"}`;
  }

  get usage(): ModelUsage {
    return { inputTokens: this.inputTokens, outputTokens: 0, costUsd: 0 };
  }

  async decide(question: DecisionQuestion, { signal, onUsage }: DecisionOptions = {}) {
    const started = performance.now();
    const criteria =
      question.type === "noul"
        ? { false: "No.", true: "Yes." }
        : Object.fromEntries(question.options.map((o) => [o, o]));
    const raw = (await postSystemOne(
      this.options,
      {
        state: question.context,
        questions: {
          [question.key]: { type: question.type, instructions: question.instruction, criteria },
        },
        model: this.options.model ?? "typed-decisions",
      },
      signal,
    )) as { answers?: Record<string, unknown>; usage?: { input_tokens?: number } };
    this.inputTokens += raw.usage?.input_tokens ?? 0;
    onUsage?.({ inputTokens: raw.usage?.input_tokens ?? 0, outputTokens: 0, costUsd: 0 });
    const answer = raw.answers?.[question.key];
    let decision: Decision;
    if (question.type === "noul") {
      const parsed = NoulAnswer.safeParse(answer);
      if (!parsed.success) throw new Error(`Laya gave no yes/no answer for ${question.key}`);
      const p = parsed.data.noul;
      decision = { answer: p >= 0.5 ? "yes" : "no", confidence: Math.max(p, 1 - p) };
    } else {
      const parsed = ChoiceAnswer.safeParse(answer);
      if (!parsed.success) throw new Error(`Laya gave no choice for ${question.key}`);
      const confidence = parsed.data.probabilities[parsed.data.choice];
      if (confidence === undefined)
        throw new Error(`Laya gave no probability for "${parsed.data.choice}" on ${question.key}`);
      decision = { answer: parsed.data.choice, confidence };
    }
    // An answer outside the allowed ones is an error, never a guess (as `parseDecision`).
    this.latenciesMs.push(performance.now() - started);
    if (!allowedAnswers(question).includes(decision.answer))
      throw new Error(`Laya answered "${decision.answer}" for ${question.key}`);
    return decision;
  }
}
