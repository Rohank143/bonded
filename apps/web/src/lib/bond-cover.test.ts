import { describe, expect, it } from "vitest";
import {
  applyPreset,
  basisLine,
  bondTable,
  minimumBond,
  premiumPerYear,
  recommendedBond,
  recommendedCover,
} from "./bond-cover";

describe("bond and cover in plain words", () => {
  it("uses the tiers' own minimum-bond rule", () => {
    expect(minimumBond(20_000, "A")).toBe(2_000);
    expect(minimumBond(20_000, "BB")).toBe(4_000);
    expect(minimumBond(20_000, "B")).toBe(6_000);
    expect(minimumBond(1, "B")).toBe(1);
    expect(bondTable(20_000)).toEqual([
      { tiers: "BBB to AAA", minBondPct: 10, bond: 2_000 },
      { tiers: "BB", minBondPct: 20, bond: 4_000 },
      { tiers: "B", minBondPct: 30, bond: 6_000 },
    ]);
  });

  it("recommends the score's minimum, or the most any insurable tier asks without one", () => {
    expect(recommendedBond(20_000, 72)).toMatchObject({ bond: 2_000 });
    expect(recommendedBond(20_000, 50).why).toMatch(/tier BB/);
    expect(recommendedBond(20_000, 10).why).toMatch(/can't be insured yet/);
    expect(recommendedBond(20_000)).toMatchObject({ bond: 6_000 });
    expect(recommendedBond(20_000, null).why).toMatch(/without a score yet/);
  });

  it("recommends no more cover than the vault holds, the policy cap or the testnet cap", () => {
    expect(recommendedCover({ vaultBalanceUsd: 3_000.7, testnetCapUsd: 100_000 })).toEqual({
      amount: 3_000,
      limitedBy: "vault",
    });
    expect(
      recommendedCover({ vaultBalanceUsd: 50_000, policyCapUsd: 5_000, testnetCapUsd: 100_000 }),
    ).toEqual({ amount: 5_000, limitedBy: "policy" });
    expect(recommendedCover({ vaultBalanceUsd: 500_000, testnetCapUsd: 100_000 })).toEqual({
      amount: 100_000,
      limitedBy: "testnet",
    });
    expect(recommendedCover({ vaultBalanceUsd: 0, testnetCapUsd: 1 })).toBeUndefined();
    expect(premiumPerYear(20_000, 250)).toBe(500);
  });

  it("applies a preset to the form, dropping tokens a vault can't hold", () => {
    expect(
      applyPreset({
        id: "conservative",
        label: "Conservative trader",
        mode: "enforce",
        tokens: ["tTSLA", "WETH"],
        maxTxUsd: 1_200,
        maxDailyUsd: 5_000,
      }),
    ).toEqual({ mode: "enforce", tokens: ["tTSLA"], maxTx: "1200", maxDaily: "5000" });
  });

  it("carries a preset's whole rules, not just its limits", () => {
    const router = "0x00000000000000000000000000000000000000c1";
    expect(
      applyPreset({
        id: "conservative",
        label: "Conservative trader",
        mode: "enforce",
        tokens: ["tTSLA"],
        maxTxUsd: 1_200,
        maxDailyUsd: 4_800,
        rules: {
          mode: "enforce",
          assets: ["0x00000000000000000000000000000000000000b1"],
          targets: [{ address: router, functions: ["swap(address,address,uint256,address)"] }],
          destinations: [],
          maxTradeUsd: 1_200,
          maxDailyUsd: 4_800,
          maxDrawdownPct: 10,
          maxSlippagePct: 1,
        },
      }),
    ).toEqual({
      mode: "enforce",
      tokens: ["tTSLA"],
      maxTx: "1200",
      maxDaily: "4800",
      drawdown: "10",
      slippage: "1",
      destinations: [],
      assets: ["0x00000000000000000000000000000000000000b1"],
      targets: [{ address: router, functions: ["swap(address,address,uint256,address)"] }],
    });
  });

  it("says where a suggested mandate came from", () => {
    const basis = {
      trades: 1,
      tokens: [],
      largestTradeUsd: 0,
      usedRouter: false,
      transfers: 0,
      approvals: 0,
    };
    expect(basisLine({ ...basis, sources: ["check"] })).toBe("your passing check (1 trade)");
    expect(basisLine({ ...basis, sources: ["check", "preview", "rating"], trades: 4 })).toBe(
      "your passing check, your preview and its rating (4 trades)",
    );
    expect(basisLine({ ...basis, sources: [] })).toBeUndefined();
    expect(basisLine(null)).toBeUndefined();
  });
});
