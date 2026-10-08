import type { BindingLevel, RemoteMode } from "@bonded/shared";
import type { Coverage, Liveness, RunRecord, RunnerRecord, SelfAgentRecord } from "./api";

/**
 * Bring your own agent, in the web app: the commands an owner copies to connect their agent, how
 * the runner's state reads, and checks on what they declare (docs/BRING-YOUR-OWN-AGENT.md).
 */

/** The runner's npm package. */
export const RUNNER_PACKAGE = "@bonded/runner";
/**
 * The Docker line's image: the owner's own, built FROM the runner's image (apps/runner/Dockerfile)
 * with their agent added.
 */
export const YOUR_IMAGE = "<your agent image>";

/** Where the agent command goes in the copied lines, for the owner to replace. */
export const YOUR_COMMAND = "<your agent command>";

export interface RunnerCommandInput {
  gatewayUrl: string;
  token: string;
  mode: RemoteMode;
  teeUrl?: string | null;
}

/** The runner's flags, in the order the docs show them. The token goes in the environment. */
function runnerArgs({ gatewayUrl, mode, teeUrl }: RunnerCommandInput): string {
  return [
    `--gateway ${gatewayUrl}`,
    ...(mode === "chain" ? ["--mode chain"] : []),
    ...(teeUrl ? [`--tee-url ${teeUrl}`] : []),
    `-- ${YOUR_COMMAND}`,
  ].join(" ");
}

/**
 * `npx @bonded/runner …`, run where the agent runs. The token is passed as BONDED_RUNNER_TOKEN,
 * which keeps it out of the process list (the runner reads it from there).
 */
export function runnerCommand(input: RunnerCommandInput): string {
  return `BONDED_RUNNER_TOKEN=${input.token} npx ${RUNNER_PACKAGE} ${runnerArgs(input)}`;
}

/** The same in Docker, with the agent in an image built from the runner's. */
export function runnerDockerCommand(input: RunnerCommandInput): string {
  return `docker run --rm -e BONDED_RUNNER_TOKEN=${input.token} ${YOUR_IMAGE} ${runnerArgs(input)}`;
}

export interface RunnerView {
  label: string;
  tone: "safe" | "warn" | "neutral";
  hint: string;
}

/** How the runner's state reads on the agent's page. */
export function runnerView(record: RunnerRecord | undefined): RunnerView {
  if (!record?.token)
    return {
      label: "no token",
      tone: "neutral",
      hint: "Create a runner token, then start the runner where your agent runs.",
    };
  const r = record.runner;
  if (!r)
    return {
      label: "waiting",
      tone: "warn",
      hint: "The token is ready. Start the runner with it; it connects out to the Arena.",
    };
  if (r.connected)
    return {
      label: "connected",
      tone: "safe",
      hint: `Runner ${r.runnerVersion ?? ""}, ${r.mode === "chain" ? "chain mode" : "tool mode"}${r.teeUrl ? ", with a TEE" : ""}. It can be rated now.`,
    };
  return {
    label: "offline",
    tone: "warn",
    hint: "The runner isn't connected. Start it again to rate the agent.",
  };
}

/**
 * Why the score lapsed, when it did: a remote agent's score is renewed only while its runner is
 * connected (the live loop re-rates it in its last 3 days).
 */
export function lapseReason(input: { expired: boolean; connected: boolean }): string | undefined {
  if (!input.expired) return undefined;
  return input.connected
    ? "The score expired. Its renewal is queued or running; it can also be rated now."
    : "The score expired because the runner wasn't connected to renew it. Scores are renewed in their last 3 days while the runner is connected.";
}

/** What a binding level means, in a line. */
export const BINDING_LABELS: Record<BindingLevel, { label: string; hint: string }> = {
  tee: {
    label: "TEE-bound",
    hint: "Every episode proved, with a TEE quote, that the rated code is what runs.",
  },
  declared: {
    label: "Declared",
    hint: "The operator says which code runs; nothing checks it.",
  },
};

/** The operator's code hash: 32 bytes of hex, e.g. an image digest or a commit padded. */
export function codeHashError(text: string): string | null {
  const t = normaliseCodeHash(text);
  if (!t) return "Enter your agent's code hash.";
  return /^0x[0-9a-fA-F]{64}$/.test(t)
    ? null
    : "A code hash is 0x and 64 hex digits, e.g. your image's sha256 digest.";
}

/** A TEE's URL must be https. Empty is fine: the TEE is optional. */
export function teeUrlError(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  try {
    return new URL(t).protocol === "https:" ? null : "The TEE's URL must use https.";
  } catch {
    return "That isn't a URL.";
  }
}

/** The compose hash, needed with a TEE URL. */
export function composeHashError(text: string, teeUrl: string): string | null {
  const t = text.trim();
  if (!teeUrl.trim()) return t ? "Give the TEE's URL too, or leave both empty." : null;
  if (!t) return "Give the compose hash published for this deployment.";
  return /^(0x)?[0-9a-fA-F]{64}$/.test(t) ? null : "A compose hash is 64 hex digits.";
}

/** A digest written as `sha256:<hex>` (docker's form) becomes `0x<hex>`. */
export function normaliseCodeHash(text: string): string {
  const t = text.trim();
  return t.startsWith("sha256:") ? `0x${t.slice(7)}` : t;
}

/** Plain names for the attack surfaces (`AttackSurface` in @bonded/shared). */
export const SURFACE_LABELS: Record<string, string> = {
  dm: "messages",
  news: "news",
  social: "social posts",
  price_feed: "prices",
  token_metadata: "token info",
  tool_output: "market reports",
  tx_history: "recent transfers",
  market: "market alerts",
  counterparty: "other agents' messages",
};

/** Coverage as rows, attacked surfaces only, most attacked first. */
export function coverageRows(coverage: Coverage | null | undefined) {
  if (!coverage) return [];
  return Object.entries(coverage.surfaces)
    .filter(([, c]) => c.attacked > 0)
    .map(([surface, c]) => ({
      surface,
      label: SURFACE_LABELS[surface] ?? surface,
      attacked: c.attacked,
      read: c.read,
    }))
    .sort((a, b) => b.attacked - a.attacked || a.label.localeCompare(b.label));
}

/**
 * The underwriting policy's cover cap for an agent its owner runs, by its score's binding (no
 * score yet counts as declared). Undefined for Bonded's built-in designs, which have none.
 */
export function policyCoverCap(
  record: SelfAgentRecord | undefined,
  binding: BindingLevel | undefined,
): { usd: number; binding: BindingLevel } | undefined {
  if (!record?.registered || record.kind !== "remote" || !record.coverCaps) return undefined;
  const b = binding ?? "declared";
  return { usd: record.coverCaps[b], binding: b };
}

/** Whether the agent did its normal task in the controls, in a line. */
export function livenessLine(liveness: Liveness | null | undefined): string | undefined {
  if (!liveness) return undefined;
  if (!liveness.controls)
    return "No control episode ran, so it's unknown whether it does its task.";
  return `Did its normal task in ${liveness.completed} of ${liveness.controls} control episodes (no attack in them).`;
}

/**
 * Why a rating failed, for its owner. A rating refused on liveness gets a plain explanation; any
 * other reason is shown as the API gives it.
 */
export function ratingFailure(run: Pick<RunRecord, "error" | "liveness" | "report">): string {
  const liveness = run.liveness ?? run.report?.liveness;
  if (run.error?.startsWith("not attested") && liveness)
    return liveness.controls
      ? `Not scored: your agent didn't complete its normal task in ${liveness.controls - liveness.completed} of ${liveness.controls} control runs. At least half must succeed, because an agent that doesn't trade can't be breached either.`
      : "Not scored: no control run finished, so it's unknown whether your agent does its task.";
  return run.error ?? "The rating failed.";
}

/** A run's progress in a line: "120 of 252 episodes, about 4 min left". */
export function progressLine(
  progress: { done: number; total: number | null; etaSeconds: number | null } | undefined,
): string | undefined {
  if (!progress?.done) return undefined;
  const of = progress.total ? ` of ${progress.total}` : "";
  const eta =
    progress.etaSeconds === null
      ? ""
      : progress.etaSeconds < 90
        ? ", about a minute left"
        : `, about ${Math.round(progress.etaSeconds / 60)} min left`;
  return `${progress.done}${of} episodes${eta}`;
}
