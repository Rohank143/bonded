/**
 * What the Sentinel page states about the model in production, copied from the recorded gate
 * results (docs/SENTINEL-STRESS.md, "v5 gate results") so every number has a source. Update it
 * together with that document whenever a new fine-tune is promoted.
 */
const REPO = "https://github.com/ddboy19912/bonded/blob/main";

export const SENTINEL_MODEL = {
  name: "Laya fine-tune v5",
  revision: "f8d305790ca9e6811e91da88d6c00c862554b0f9",
  base: "Laya, Convai Innovations' open-source decision model",
  heldOutClasses: ["A7", "A10"],
  /** Per check, measured (docs/SENTINEL.md, "Speed"). */
  speed: { cpu: "about 2.5 s on CPU (where it runs today)", gpu: "about 0.2 s on a T4 GPU" },
  source: `${REPO}/docs/SENTINEL-STRESS.md#v5-gate-results`,
  overview: `${REPO}/docs/SENTINEL.md`,
  issue: "https://github.com/ddboy19912/bonded/issues/55",
};

export interface SentinelGate {
  name: string;
  what: string;
  /** The previous model (v1) and v5, as the gate measured them. */
  before: string;
  after: string;
  passed: boolean;
}

export const SENTINEL_GATES: SentinelGate[] = [
  {
    name: "Held-out Arena cases",
    what: "Real Arena episodes from attack classes it never trained on (A7, A10)",
    before: "27 of 33 manipulated actions blocked",
    after: "33 of 33 blocked, and none of the unmanipulated ones",
    passed: true,
  },
  {
    name: "Stress suite",
    what: "528 disguised cases in 44 families, scored on the locked split",
    before: "right 92% of the time",
    after: "right 97% of the time, but worse in 2 of 44 families",
    passed: false,
  },
  {
    name: "Fresh benign episodes",
    what: "Ordinary trades it should let through",
    before: "1 of 45 blocked",
    after: "0 of 45 blocked",
    passed: true,
  },
  {
    name: "Arena rerun",
    what: "A deliberately vulnerable agent rated with Sentinel in front of it",
    before: "breached by 3 of 40 attack seeds",
    after: "breached by 0 of 40",
    passed: true,
  },
  {
    name: "Consistency",
    what: "The same run with harmless edits should get the same answer",
    before: "answer changed in 2.8% of edited runs",
    after: "changed in 0.7%",
    passed: true,
  },
];
