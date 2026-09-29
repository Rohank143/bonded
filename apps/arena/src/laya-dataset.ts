import { SENTINEL_HELD_OUT_CLASSES, SENTINEL_QUESTIONS } from "@bonded/shared";
import type { SentinelRow } from "./dataset.js";
import type { SyntheticRow } from "./synthetic.js";

/**
 * Sentinel training data in Laya's typed-decision format (docs/PLAN.md Section 10.3), the
 * shape of its reference dataset LocalLLaMA/typed-decisions and what its Kaggle fine-tuning
 * notebook reads: one row per proposed action, with `state`, `questions` and `gold` as JSON
 * strings. See services/sentinel/kaggle/README.md.
 */
export interface LayaRow {
  id: string;
  workflow: "bonded_sentinel";
  split: "train" | "test";
  state: string;
  questions: string;
  gold: string;
  /** Not read by the notebook; kept for analysis and per-class evaluation. */
  source: "arena" | "synthetic";
  attackClass: string | null;
}

/**
 * Probability on the labelled answer. Labels are hard (the vault's breach log, or a synthetic
 * request), but Laya is trained to report calibrated probabilities, so the rest is spread over
 * the other options. Synthetic labels are less certain than the judge's. These are assumptions.
 */
export const LABEL_CONFIDENCE = { arena: 0.95, synthetic: 0.9 } as const;

type AnyRow = SentinelRow | SyntheticRow;
const isSynthetic = (row: AnyRow): row is SyntheticRow =>
  "source" in row && row.source === "synthetic";

function gold(keys: readonly string[], label: string, confidence: number) {
  const rest = (1 - confidence) / (keys.length - 1);
  const probabilities = Object.fromEntries(
    keys.map((k) => [k, Number((k === label ? confidence : rest).toFixed(6))]),
  );
  return { label, probabilities };
}

/** One Arena or synthetic row as one Laya row with all three Sentinel questions. */
export function toLayaRow(row: AnyRow, split: LayaRow["split"]): LayaRow {
  const source = isSynthetic(row) ? "synthetic" : "arena";
  const confidence = LABEL_CONFIDENCE[source];
  const { manipulated, action_risk, injection_in_inputs } = row.labels;
  const questions = Object.fromEntries(
    Object.entries(SENTINEL_QUESTIONS).map(([key, q]) => [
      key,
      { type: q.type, instructions: q.instructions, criteria: q.criteria },
    ]),
  );
  const answers = {
    manipulated: gold(["false", "true"], String(manipulated), confidence),
    action_risk: gold(
      Object.keys(SENTINEL_QUESTIONS.action_risk.criteria),
      action_risk,
      confidence,
    ),
    injection_in_inputs: gold(["false", "true"], String(injection_in_inputs), confidence),
  };
  const golds = Object.fromEntries(
    Object.entries(answers).map(([key, g]) => [
      key,
      { type: SENTINEL_QUESTIONS[key as keyof typeof answers].type, ...g, confidence },
    ]),
  );
  return {
    id: row.id,
    workflow: "bonded_sentinel",
    split,
    // The three minimal-context fields the serving guard sends (plan Section 10.2).
    state: JSON.stringify({
      mandate: row.mandate,
      proposed_action: row.proposedAction,
      untrusted_inputs: row.untrustedInputs,
    }),
    questions: JSON.stringify(questions),
    gold: JSON.stringify(golds),
    source,
    attackClass: row.attackClass,
  };
}

export interface LayaDataset {
  train: LayaRow[];
  test: LayaRow[];
  manifest: {
    heldOutClasses: readonly string[];
    labelConfidence: typeof LABEL_CONFIDENCE;
    counts: Record<"train" | "test", Record<string, number>>;
    labels: Record<"train" | "test", Record<string, Record<string, number>>>;
  };
}

/**
 * Split into training and held-out test rows. Test holds only real Arena rows: every row from
 * a held-out class, plus control episodes (no attack), as benign traffic. Training holds the
 * synthetic rows and the remaining real rows. Throws if a held-out class would reach training.
 */
export function buildLayaDataset(input: {
  arena: SentinelRow[];
  synthetic: SyntheticRow[];
  heldOutClasses?: readonly string[];
}): LayaDataset {
  const heldOut = new Set<string>(input.heldOutClasses ?? SENTINEL_HELD_OUT_CLASSES);
  const leaked = input.synthetic.filter((r) => r.attackClass && heldOut.has(r.attackClass));
  if (leaked.length > 0)
    throw new Error(
      `${leaked.length} synthetic row(s) are from held-out classes (e.g. ${leaked[0]!.id}); regenerate them with the held-out classes excluded`,
    );
  const ids = new Set<string>();
  for (const row of [...input.arena, ...input.synthetic]) {
    if (ids.has(row.id)) throw new Error(`duplicate row id ${row.id}`);
    ids.add(row.id);
  }
  const isTest = (r: SentinelRow) => r.attackClass === null || heldOut.has(r.attackClass);
  const train = [
    ...input.arena.filter((r) => !isTest(r)).map((r) => toLayaRow(r, "train")),
    ...input.synthetic.map((r) => toLayaRow(r, "train")),
  ];
  const test = input.arena.filter(isTest).map((r) => toLayaRow(r, "test"));

  const tally = (rows: LayaRow[], key: (r: LayaRow) => string) =>
    rows.reduce<Record<string, number>>((acc, r) => {
      const k = key(r);
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
  const labelTally = (rows: LayaRow[]) =>
    Object.fromEntries(
      Object.keys(SENTINEL_QUESTIONS).map((q) => [
        q,
        tally(rows, (r) => (JSON.parse(r.gold) as Record<string, { label: string }>)[q]!.label),
      ]),
    );
  return {
    train,
    test,
    manifest: {
      heldOutClasses: [...heldOut],
      labelConfidence: LABEL_CONFIDENCE,
      counts: {
        train: tally(train, (r) => `${r.source}:${r.attackClass ?? "none"}`),
        test: tally(test, (r) => `${r.source}:${r.attackClass ?? "none"}`),
      },
      labels: { train: labelTally(train), test: labelTally(test) },
    },
  };
}
