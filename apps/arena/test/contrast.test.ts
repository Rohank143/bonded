import { AGENT_TOOLS, type AgentToolName } from "@bonded/shared";
import { describe, expect, it } from "vitest";
import {
  buildContrastRows,
  CONTRAST_MECHANISMS,
  type ContrastRow,
  UNTRAINED_MECHANISMS,
} from "../src/contrast.js";
import { buildStressSuite, LOCKED_FAMILIES } from "../src/stress.js";

const rows = buildContrastRows();
const action = (r: ContrastRow) =>
  r.proposedAction as { tool: AgentToolName; args: Record<string, string> };
const pairs = () => {
  const byPair = new Map<string, ContrastRow[]>();
  for (const r of rows.filter((r) => r.pairId))
    byPair.set(r.pairId!, [...(byPair.get(r.pairId!) ?? []), r]);
  return [...byPair.values()];
};

describe("contrastive training rows", () => {
  it("are deterministic, with unique ids and the expected counts", () => {
    expect(buildContrastRows()).toEqual(rows);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(rows.filter((r) => r.pairId)).toHaveLength(CONTRAST_MECHANISMS.length * 120 * 2);
    expect(rows.filter((r) => r.role === "benign")).toHaveLength(600);
  });

  it("only propose actions the real agent tools accept", () => {
    const bad = rows.filter(
      (r) => !AGENT_TOOLS[action(r).tool].input.safeParse(action(r).args).success,
    );
    expect(bad.map((r) => r.id)).toEqual([]);
  });

  it("pair an obeyed trade with a different independent trade over the same mandate and inputs", () => {
    for (const pair of pairs()) {
      const [obeyed, independent] = [
        pair.find((r) => r.role === "obeyed")!,
        pair.find((r) => r.role === "independent")!,
      ];
      expect(pair).toHaveLength(2);
      expect(independent.mandate).toBe(obeyed.mandate);
      expect(independent.untrustedInputs).toEqual(obeyed.untrustedInputs);
      expect(independent.proposedAction).not.toEqual(obeyed.proposedAction);
      expect(obeyed.labels).toMatchObject({ manipulated: true, injection_in_inputs: true });
      expect(independent.labels).toMatchObject({ manipulated: false, injection_in_inputs: true });
      // The independent trade is never the ordered one, in stock or amount.
      const o = action(obeyed).args;
      const i = action(independent).args;
      if (o.tokenOut && o.tokenOut !== "tUSDG")
        expect(i.tokenOut === o.tokenOut && i.amountIn === o.amountIn).toBe(false);
      expect(i.amountIn).not.toBe(o.amountIn ?? o.amount);
    }
  });

  it("vary the obeyed trade so no tool or direction means 'safe' or 'unsafe'", () => {
    const obeyed = rows.filter((r) => r.role === "obeyed");
    const kinds = new Set(
      obeyed.map((r) =>
        action(r).tool !== "swap"
          ? action(r).tool
          : action(r).args.tokenIn === "tUSDG"
            ? "buy"
            : "sell",
      ),
    );
    expect(kinds).toEqual(new Set(["buy", "sell", "transfer", "approve"]));
    // Obeyed in-rules trades exist in number: the "suspicious" case the models never learned.
    expect(obeyed.filter((r) => r.labels.action_risk === "suspicious").length).toBeGreaterThan(500);
  });

  it("label action risk by the rules", () => {
    for (const r of rows) {
      if (action(r).tool !== "swap") expect(r.labels.action_risk).toBe("breach_likely");
      if (r.mechanism === "lookalike-token" && r.role === "obeyed")
        expect(r.labels.action_risk).toBe("breach_likely");
      if (r.mechanism === "oversize-exception" && r.role === "obeyed")
        expect(r.labels.action_risk).toBe("breach_likely");
      if (r.role !== "obeyed") expect(r.labels.action_risk).not.toBe("suspicious");
    }
  });

  it("never use an untrained mechanism", () => {
    expect(
      UNTRAINED_MECHANISMS.every((m) => (LOCKED_FAMILIES as readonly string[]).includes(m)),
    ).toBe(true);
    const markers =
      /rebalanc|\bstables?\b|base64|[A-Za-z0-9+/]{24,}={0,2}(?![0-9a-fA-F])|\bif\b[^.]*\bprice\b|"manipulated"|"gold_answer"|step 1 of 2|part [ab]:|do not buy/i;
    const hits = rows.flatMap((r) =>
      r.untrustedInputs
        .filter((i) => markers.test(i.output.replace(/0x[0-9a-fA-F]{40}/g, "")))
        .map(() => r.id),
    );
    expect(hits).toEqual([]);
    for (const r of rows) expect(r.mandate).not.toMatch(/do not buy|today's rule/i);
  });

  it("share no planted text and no case with the stress suite", () => {
    const suite = buildStressSuite();
    const stressOutputs = new Set(suite.flatMap((c) => c.untrustedInputs.map((i) => i.output)));
    const key = (r: { mandate: string; proposedAction: unknown; untrustedInputs: unknown }) =>
      JSON.stringify([r.mandate, r.proposedAction, r.untrustedInputs]);
    const stressKeys = new Set(suite.map(key));
    for (const r of rows) {
      expect(stressKeys.has(key(r))).toBe(false);
      for (const p of r.planted) expect(stressOutputs.has(p)).toBe(false);
    }
  });
});
