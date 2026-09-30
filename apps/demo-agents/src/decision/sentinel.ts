import {
  type ActionGuard,
  type GuardContext,
  type GuardVerdict,
  PolicyGuard,
} from "../hardened/guard.js";
import type { ModelUsage } from "../usage.js";
import { DecisionModelSentinel, type SentinelModel } from "./laya.js";
import type { DecisionModel } from "./model.js";

/** The deployed guard's default; evaluation must measure blocking at the same threshold. */
export const DEFAULT_SENTINEL_BLOCK_THRESHOLD = 0.7;

/**
 * Sentinel as a guard (docs/PLAN.md Section 10.2): a model judges each proposed write from
 * minimal context (the mandate, the action and the untrusted inputs, in separate fields),
 * never the agent's whole conversation. It blocks only an action judged manipulated with
 * enough confidence.
 *
 * "Breach likely" doesn't block. The vault already enforces the mandate deterministically,
 * so that answer adds nothing the chain doesn't check, and v1 of the fine-tune gave it for
 * 9 of 49 ordinary trades (docs/progress/DAY-10.md). It stays in the labels, and a cascade
 * treats it as a reason to ask the second model.
 *
 * With a v3 model, which isn't asked about action risk, the guard computes it: the policy
 * guard's exact check gives within the mandate or breach, and a manipulated action within the
 * rules is labelled suspicious. `action_risk_source` says which one a label came from.
 *
 * Its labels are advisory for ratings and claims; only the vault decides those.
 */
export class SentinelGuard implements ActionGuard {
  readonly name: string;
  private readonly model: SentinelModel;

  /**
   * @param model a Sentinel model (Laya, a cascade) or any typed decision model, which is asked
   *   the three questions one by one.
   * @param threshold block when the manipulated probability is at least this.
   */
  constructor(
    model: SentinelModel | DecisionModel,
    private readonly threshold = DEFAULT_SENTINEL_BLOCK_THRESHOLD,
  ) {
    this.model = "assess" in model ? model : new DecisionModelSentinel(model);
    this.name = `sentinel/${this.model.name}`;
  }

  /** The model's usage, so the agent can report it and a spending cap can count it. */
  get usage(): ModelUsage | undefined {
    return this.model.usage;
  }

  async check(
    tool: string,
    args: Record<string, string>,
    context: GuardContext,
  ): Promise<GuardVerdict> {
    const assessment = await this.model.assess({
      mandate: context.task.mandate,
      proposedAction: { tool, args },
      untrustedInputs: context.untrustedCalls,
    });
    const risk = assessment.actionRisk
      ? { action_risk: assessment.actionRisk.answer, action_risk_source: "model" }
      : {
          action_risk: await codeRisk(tool, args, context, assessment.manipulated),
          action_risk_source: "code",
        };
    const labels = {
      manipulated: assessment.manipulated,
      ...risk,
      injection_in_inputs: assessment.injection,
      model: assessment.model,
      latencyMs: Math.round(assessment.latencyMs),
      ...(assessment.escalated ? { escalated: true } : {}),
      ...(assessment.primaryLatencyMs === undefined
        ? {}
        : { primaryLatencyMs: Math.round(assessment.primaryLatencyMs) }),
      ...(assessment.fallbackLatencyMs === undefined
        ? {}
        : { fallbackLatencyMs: Math.round(assessment.fallbackLatencyMs) }),
    };
    if (assessment.manipulated >= this.threshold) {
      return { allow: false, reason: "judged manipulated by untrusted content", labels };
    }
    return { allow: true, labels };
  }
}

const policy = new PolicyGuard();

/**
 * Action risk from the rules, for a model that isn't asked: the policy guard's exact check
 * decides breach; a manipulated action inside the rules is suspicious.
 */
async function codeRisk(
  tool: string,
  args: Record<string, string>,
  context: GuardContext,
  manipulated: number,
): Promise<"within_mandate" | "suspicious" | "breach_likely"> {
  const verdict = await policy.check(tool, args, context);
  if (!verdict.allow) return "breach_likely";
  return manipulated >= 0.5 ? "suspicious" : "within_mandate";
}
