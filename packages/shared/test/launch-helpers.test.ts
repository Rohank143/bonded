import { describe, expect, it } from "vitest";
import {
  EMPTY_TRADING,
  FIXES,
  FIXES_BY_BREACH,
  FIXES_BY_CLASS,
  LOW_GAS_TRADES,
  PROBLEMS,
  UNKNOWN_PROBLEM,
  agentGasStatus,
  codedProblem,
  fixesFor,
  mergeTrading,
  problemCode,
  rankFixes,
  suggestMandate,
  topFixIds,
  troubleshootingList,
} from "../src/index.js";

describe("the troubleshooting codes", () => {
  it("are unique, and each entry's own sentence gets its own code", () => {
    const codes = PROBLEMS.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const p of PROBLEMS) expect([p.code, problemCode(p.sentence)]).toEqual([p.code, p.code]);
    expect(troubleshootingList()[0]).toEqual({
      code: PROBLEMS[0]!.code,
      area: PROBLEMS[0]!.area,
      sentence: PROBLEMS[0]!.sentence,
      fix: PROBLEMS[0]!.fix,
    });
  });
  it("recognise the sentences the services produce, numbers and all", () => {
    expect(
      problemCode(
        "The runner isn't connected. Start it with the command on this page, then check again.",
      ),
    ).toBe("runner-not-connected");
    expect(
      problemCode(
        "You can start at most 5 previews a day. Try again after 2026-10-10T00:00:00.000Z.",
      ),
    ).toBe("preview-limit");
    expect(
      problemCode(
        "stopped: the rating ran past its 90-minute budget after 3 of 40 episodes; the agent took 80% of the time",
      ),
    ).toBe("rating-over-budget-agent");
    expect(
      problemCode(
        "stopped: the rating ran past its 90-minute budget after 3 of 40 episodes, not because of the agent; it will be retried",
      ),
    ).toBe("rating-over-budget");
    expect(problemCode("That preview wasn't found.")).toBe("not-found");
    expect(problemCode("something nobody wrote")).toBe(UNKNOWN_PROBLEM);
    expect(codedProblem("Set your Agent URL first.")).toMatchObject({
      code: "agent-url-missing",
      fix: expect.stringMatching(/HTTPS endpoint/),
    });
  });
});

describe("report fixes", () => {
  it("cover every class and breach type from the table, without what is already on", () => {
    for (const ids of [...Object.values(FIXES_BY_CLASS), ...Object.values(FIXES_BY_BREACH)])
      for (const id of ids) expect(FIXES[id]).toBeDefined();
    const monitor = fixesFor({ attackClass: "A6", breachTypes: ["T1_UNAUTHORIZED_TRANSFER"] });
    expect(monitor.map((f) => f.id)).toEqual([
      "prompt_operator_only",
      "sentinel",
      "mandate_enforce",
      "mandate_destinations",
      "sdk_guard",
    ]);
    expect(monitor[0]!.promptLine).toMatch(/never authorise a transfer/);
    const enforced = fixesFor({
      attackClass: "A6",
      breachTypes: ["T1_UNAUTHORIZED_TRANSFER"],
      mode: "enforce",
      sentinel: true,
    });
    expect(enforced.map((f) => f.id)).not.toContain("mandate_enforce");
    expect(enforced.map((f) => f.id)).not.toContain("sentinel");
  });
  it("rank by how many breaches each addresses", () => {
    const ids = (c: Parameters<typeof fixesFor>[0]) => ({ fixes: fixesFor(c).map((f) => f.id) });
    const ranked = rankFixes([
      ids({ attackClass: "A1", breachTypes: ["T3_ASSET"] }),
      ids({ attackClass: "A1", breachTypes: ["T3_ASSET"] }),
      ids({ attackClass: "A8", breachTypes: ["T2_LIMIT"] }),
    ]);
    expect(ranked.slice(0, 3).map((f) => [f.id, f.prevents])).toEqual([
      ["mandate_enforce", 3],
      ["sdk_guard", 3],
      ["prompt_untrusted_content", 2],
    ]);
    expect(topFixIds(ranked)).toEqual(["mandate_enforce", "sdk_guard", "prompt_untrusted_content"]);
    expect(rankFixes([])).toEqual([]);
  });
});

describe("the suggested mandate", () => {
  const market = {
    usdg: "0x0000000000000000000000000000000000000001",
    router: "0x0000000000000000000000000000000000000009",
    tokens: {
      tUSDG: "0x0000000000000000000000000000000000000001",
      tNVDA: "0x0000000000000000000000000000000000000002",
      tTSLA: "0x0000000000000000000000000000000000000003",
    },
  };
  it("takes the tokens it traded and its largest trade, with headroom per preset", () => {
    const trading = mergeTrading([
      {
        ...EMPTY_TRADING,
        trades: 1,
        tokens: ["tNVDA", "tUSDG"],
        usedRouter: true,
        largestTradeUsd: 2000,
        totalOutflowUsd: 2000,
      },
      {
        ...EMPTY_TRADING,
        trades: 2,
        tokens: ["tUSDG"],
        usedRouter: true,
        largestTradeUsd: 1500,
        totalOutflowUsd: 3000,
      },
      null,
    ]);
    expect(trading).toMatchObject({ trades: 3, tokens: ["tNVDA", "tUSDG"], largestTradeUsd: 2000 });
    const s = suggestMandate({ chainId: 46630, market, trading, sources: ["check", "preview"] });
    expect(s.recommended).toBe("conservative");
    expect(s.presets[0]!.rules).toMatchObject({
      mode: "enforce",
      baseAsset: market.usdg,
      assets: [market.tokens.tNVDA],
      maxTradeUsd: 2500,
      maxDailyUsd: 10_000,
      destinations: [],
      targets: [{ address: market.router, functions: ["swap(address,address,uint256,address)"] }],
    });
    expect(s.presets[1]!.rules.maxTradeUsd).toBe(4000);
    expect(s.presets[1]!.rules.assets).toEqual([market.tokens.tNVDA, market.tokens.tTSLA]);
    expect(s.presets[0]).toMatchObject({ id: "conservative", tokens: ["tNVDA"], maxTxUsd: 2500 });
    expect(s).toMatchObject({
      tokens: ["tNVDA"],
      largestTradeUsd: 2000,
      contracts: [{ address: market.router }],
    });
    expect(s.notes).toEqual([]);
  });
  it("says so when nothing was seen, or when it sent or approved", () => {
    const none = suggestMandate({ chainId: 1, market, trading: EMPTY_TRADING, sources: [] });
    expect(none.presets[0]!.rules.maxTradeUsd).toBe(5000);
    expect(none.notes[0]).toMatch(/No trade was seen/);
    const sent = suggestMandate({
      chainId: 1,
      market,
      trading: { ...EMPTY_TRADING, trades: 1, transfers: 1, approvals: 1, largestTradeUsd: 10 },
      sources: ["check"],
    });
    expect(sent.notes.join(" ")).toMatch(/destinations/);
    expect(sent.notes.join(" ")).toMatch(/approved spenders/);
    expect(sent.presets[0]!.rules.maxTradeUsd).toBe(100);
  });
});

describe("agent gas", () => {
  it("estimates trades left from measured or assumed gas, and flags low", () => {
    const gwei = 1_000_000_000n;
    const ok = agentGasStatus({
      balanceWei: 10n ** 17n,
      gasPriceWei: gwei,
      measuredGasPerTrade: 200_000n,
    });
    expect(ok).toMatchObject({ basis: "measured", estimatedTradesLeft: 500, low: false });
    const low = agentGasStatus({ balanceWei: 350_000n * gwei * 5n, gasPriceWei: gwei });
    expect(low).toMatchObject({ basis: "assumed", estimatedTradesLeft: 5, low: true });
    expect(low.estimatedTradesLeft! < LOW_GAS_TRADES).toBe(true);
    expect(agentGasStatus({ balanceWei: 0n, gasPriceWei: null })).toMatchObject({
      low: true,
      estimatedTradesLeft: null,
    });
  });
});
