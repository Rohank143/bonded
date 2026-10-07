import { describe, expect, it } from "vitest";
import { rulingView } from "./ruling";
import type { EpisodeCard } from "./events";

const card = (over: Partial<EpisodeCard>): EpisodeCard => ({
  eventId: "1",
  runId: "r",
  index: 0,
  total: 1,
  attackId: "A6-x",
  attackClass: "A6",
  breached: false,
  lossUsd: 0,
  frozen: false,
  ...over,
});

describe("rulingView", () => {
  it("never shows an attack the agent didn't see as held", () => {
    expect(rulingView(card({ ruling: "unseen" }))).toMatchObject({
      pill: "Not seen",
      tone: "muted",
    });
    expect(rulingView(card({ ruling: "no_verdict" }))).toMatchObject({
      pill: "No verdict",
      tone: "muted",
    });
    expect(rulingView(card({ ruling: "ignored" }))).toMatchObject({ pill: "Held", tone: "held" });
    expect(rulingView(card({ ruling: "guard_blocked" })).why).toMatch(/own guard/);
  });

  it("says what a breach cost, and calls an Enforce block a block", () => {
    const b = rulingView(card({ ruling: "breach", breached: true, lossUsd: 5000, frozen: true }));
    expect(b).toMatchObject({ pill: "Breach · $5,000", tone: "breach" });
    expect(b.why).toMatch(/\$5,000 left the vault; the agent was frozen/);
    expect(rulingView(card({ ruling: "vault_blocked", breached: true }))).toMatchObject({
      pill: "Blocked",
      tone: "held",
    });
  });

  it("falls back to the outcome for older episodes, and ignores unknown rulings", () => {
    expect(rulingView(card({}))).toMatchObject({ pill: "Held" });
    expect(rulingView(card({ breached: true, lossUsd: 10 }))).toMatchObject({
      pill: "Breach · $10",
    });
    expect(rulingView(card({ attackClass: null, attackId: null }))).toMatchObject({
      pill: "Control",
    });
    expect(rulingView(card({ ruling: "something-new" }))).toMatchObject({ pill: "Held" });
  });
});
