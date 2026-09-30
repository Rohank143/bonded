import {
  SENTINEL_HELD_OUT_CLASSES,
  SENTINEL_QUESTIONS,
  sentinelQuestions,
  sentinelState,
} from "@bonded/shared";
import type { SentinelRow } from "./dataset.js";
import { overTradeLimit, type SyntheticRow } from "./synthetic.js";

/**
 * Sentinel training data in Laya's typed-decision format (docs/PLAN.md Section 10.3), the
 * shape of its reference dataset LocalLLaMA/typed-decisions and what its Kaggle fine-tuning
 * notebook reads: one row per proposed action, with `state`, `questions` and `gold` as JSON
 * strings. See services/sentinel/kaggle/README.md.
 */
export interface LayaRow {
  id: string;
  /**
   * The group a row is reported under: `sentinel/train` for training rows, and
   * `sentinel/<class>` or `sentinel/control` for test rows. The notebook reports accuracy per
   * workflow, so this gives results per held-out class.
   */
  workflow: string;
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
  const questions = sentinelQuestions();
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
    workflow: split === "train" ? "sentinel/train" : `sentinel/${row.attackClass ?? "control"}`,
    split,
    // The three minimal-context fields the serving guard sends (plan Section 10.2).
    state: JSON.stringify(
      sentinelState({
        mandate: row.mandate,
        proposedAction: row.proposedAction,
        untrustedInputs: row.untrustedInputs,
      }),
    ),
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
    /** Synthetic rows left out of training because their seed is a test-split episode. */
    droppedSeededFromTest: number;
    /** Synthetic rows not labelled a breach whose swap exceeds the per-trade limit. */
    droppedOverTradeLimit: number;
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
  // A synthetic row is derived from its seed (the seed's mandate, inputs and action are in the
  // prompt), so one seeded from a test episode would leak that episode into training. Its
  // seed must be one of the given Arena rows, or provenance can't be checked.
  const arenaById = new Map(input.arena.map((r) => [r.id, r]));
  const unknown = input.synthetic.filter((r) => !arenaById.has(r.generator?.seedId));
  if (unknown.length > 0)
    throw new Error(
      `${unknown.length} synthetic row(s) have a seed that isn't among the Arena rows given (e.g. ${unknown[0]!.id}); pass the ratings they were seeded from with --arena`,
    );
  const seededFromTest = (r: SyntheticRow) => isTest(arenaById.get(r.generator.seedId)!);
  const notFromTest = input.synthetic.filter((r) => !seededFromTest(r));
  // A swap above the per-trade limit is a breach whatever the scene says, so a row labelled
  // otherwise is mislabelled (overTradeLimit). Rows generated before that check get it here.
  const synthetic = notFromTest.filter(
    (r) => r.labels.action_risk === "breach_likely" || !overTradeLimit(r),
  );
  const train = [
    ...input.arena.filter((r) => !isTest(r)).map((r) => toLayaRow(r, "train")),
    ...synthetic.map((r) => toLayaRow(r, "train")),
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
      droppedSeededFromTest: input.synthetic.length - notFromTest.length,
      droppedOverTradeLimit: notFromTest.length - synthetic.length,
      labelConfidence: LABEL_CONFIDENCE,
      counts: {
        train: tally(train, (r) => `${r.source}:${r.attackClass ?? "none"}`),
        test: tally(test, (r) => `${r.source}:${r.attackClass ?? "none"}`),
      },
      labels: { train: labelTally(train), test: labelTally(test) },
    },
  };
}
