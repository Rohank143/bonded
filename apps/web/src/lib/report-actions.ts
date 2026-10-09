import type { Report, RunRecord } from "./api";
import { SURFACE_LABELS } from "./byoa";

/**
 * The actionable part of a report (launch item 2.1): for each breached episode, what the agent
 * read, what it did and what would have stopped it; and a before/after between two ratings
 * (2.2). The fixes are the API's own deterministic advice, by attack class and breach type, never
 * a model's. Planted text is in a report only once its rating has finished.
 */

/** What the agent did in a breached episode: a tool call, or a decoded `execute`. */
export interface BreachAction {
  tool?: string | null;
  args?: Record<string, unknown> | null;
  /** A chain-mode `execute`, decoded, e.g. "transfer 4,000 tUSDG to 0xBad…". */
  decoded?: string | null;
}

export interface BreachEvidence {
  episodeId?: string;
  class: string;
  className?: string;
  /** The surface the attack was planted on (`AttackSurface`), when it had one. */
  surface?: string | null;
  /** The exact text the agent read. Only once the rating has finished. */
  plantedText?: string | null;
  /** A held-out attack, made for this rating alone. */
  heldOut?: boolean;
  action?: BreachAction | null;
  /** The breach the vault recorded, e.g. "T1 unauthorized transfer". */
  breachType: string;
  lossUsd: number;
  /** Ids of the fixes (`ReportFix.id`) that would have stopped it. */
  fixes?: string[];
}

export type FixKind = "prompt" | "mandate" | "guard" | "sentinel";

export interface ReportFix {
  id: string;
  kind: FixKind;
  title: string;
  detail?: string | null;
  /** For a prompt fix: the line to add to the system prompt. */
  promptLine?: string | null;
  /** For a mandate fix: the setting, e.g. "Allow only these recipients: 0x…". */
  setting?: string | null;
  /** How many of this rating's breaches it would have prevented. */
  prevents: number;
}

/** A report with the actionable fields, as the run and report endpoints give them. */
export type ActionableReport = Report & {
  evidence?: BreachEvidence[];
  fixes?: ReportFix[];
  /** The three fixes that prevent the most breaches: ids, or the fixes themselves. */
  topFixes?: (string | ReportFix)[];
};

export const FIX_KIND_LABELS: Record<FixKind, string> = {
  prompt: "System prompt",
  mandate: "Mandate",
  guard: "SDK guard",
  sentinel: "Sentinel",
};

const asActionable = (r: Report | null | undefined) => r as ActionableReport | null | undefined;

export function evidenceOf(report: ActionableReport | null | undefined): BreachEvidence[] {
  return asActionable(report)?.evidence ?? [];
}

/** The top fixes (at most 3): the API's own pick, or the fixes that prevent the most. */
export function topFixes(report: ActionableReport | null | undefined): ReportFix[] {
  const r = asActionable(report);
  if (!r) return [];
  const all = r.fixes ?? [];
  const byId = new Map(all.map((f) => [f.id, f]));
  const picked = r.topFixes?.length
    ? r.topFixes.flatMap((t) => {
        const f = typeof t === "string" ? byId.get(t) : t;
        return f ? [f] : [];
      })
    : [...all].sort((a, b) => b.prevents - a.prevents || a.id.localeCompare(b.id));
  return picked.filter((f) => f.prevents > 0).slice(0, 3);
}

/** The fixes for one breach, resolved from its ids. */
export function fixesFor(
  evidence: BreachEvidence,
  report: ActionableReport | null | undefined,
): ReportFix[] {
  const byId = new Map((asActionable(report)?.fixes ?? []).map((f) => [f.id, f]));
  return (evidence.fixes ?? []).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

/** What the agent did, in a line. */
export function actionLine(action: BreachAction | null | undefined): string {
  if (!action) return "No action was recorded.";
  if (action.decoded) return action.decoded;
  if (action.tool) {
    const args = action.args ? JSON.stringify(action.args) : "";
    return args && args !== "{}" ? `${action.tool}(${args})` : `${action.tool}()`;
  }
  return "No action was recorded.";
}

/** Where the attack was, in words: "planted in its messages". */
export function surfaceLine(surface: string | null | undefined): string | undefined {
  if (!surface) return undefined;
  return `planted in ${SURFACE_LABELS[surface] ?? surface}`;
}

/** Two ratings side by side, as GET …/compare gives them (or as the page works them out). */
export interface RatingSide {
  runId: string;
  score: number | null;
  /** Expected loss of cover a year, in basis points, when the API gives it. */
  expectedLossBps?: number | null;
}

export interface ClassDiff {
  class: string;
  name: string;
  from: { breaches: number; episodes: number } | null;
  to: { breaches: number; episodes: number } | null;
}

export interface RatingCompare {
  from: RatingSide;
  to: RatingSide;
  classes: ClassDiff[];
}

/** The comparison from two finished runs, for an API that has no compare endpoint yet. */
export function compareRuns(from: RunRecord, to: RunRecord): RatingCompare {
  const classes = new Map<string, ClassDiff>();
  for (const c of from.report?.classes ?? [])
    classes.set(c.class, {
      class: c.class,
      name: c.name,
      from: { breaches: c.breaches, episodes: c.episodes },
      to: null,
    });
  for (const c of to.report?.classes ?? []) {
    const row = classes.get(c.class) ?? { class: c.class, name: c.name, from: null, to: null };
    classes.set(c.class, { ...row, to: { breaches: c.breaches, episodes: c.episodes } });
  }
  return {
    from: { runId: from.id, score: from.report?.scoring.score ?? null },
    to: { runId: to.id, score: to.report?.scoring.score ?? null },
    classes: [...classes.values()].sort((a, b) => a.class.localeCompare(b.class)),
  };
}

/** "54 → 81", or what's missing. */
export function scoreChange(c: RatingCompare): string {
  const s = (v: number | null) => (v === null ? "no score" : String(v));
  return `${s(c.from.score)} → ${s(c.to.score)}`;
}

/** A class's change in breaches, in words: "3 fewer breaches", "the same", "1 more breach". */
export function classChange(d: ClassDiff): { text: string; tone: "safe" | "breach" | "neutral" } {
  if (!d.from || !d.to)
    return { text: d.to ? "new in this rating" : "not in this rating", tone: "neutral" };
  const delta = d.to.breaches - d.from.breaches;
  if (delta === 0) return { text: "the same", tone: "neutral" };
  const n = Math.abs(delta);
  const word = n === 1 ? "breach" : "breaches";
  return delta < 0
    ? { text: `${n} fewer ${word}`, tone: "safe" }
    : { text: `${n} more ${word}`, tone: "breach" };
}
