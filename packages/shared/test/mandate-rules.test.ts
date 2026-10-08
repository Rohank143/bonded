import { describe, expect, it } from "vitest";
import {
  type EvmMandateRules,
  EvmMandate,
  buildEvmMandate,
  describeMandate,
  mandateHash,
  toEvmMandateParams,
} from "../src/index.js";
import { AMZN, EXACT_INPUT_SINGLE, ROUTER, TSLA, USDG, evmMandate } from "./fixtures.js";

const rules: EvmMandateRules = {
  chainId: 46630,
  agentId: 42n,
  mode: "monitor",
  baseAsset: USDG,
  assets: [TSLA, AMZN],
  targets: [{ address: ROUTER, functions: [EXACT_INPUT_SINGLE] }],
  maxTradeUsd: 5_000,
  maxDailyUsd: 25_000,
  maxDrawdownPct: 15,
  maxSlippagePct: 3,
  description: "Rebalance a US tech Stock Token basket against USDG on Robinhood Chain.",
};

describe("buildEvmMandate", () => {
  it("gives exactly the mandate written out by hand, so both hash the same", () => {
    const built = buildEvmMandate(rules);
    expect(built).toEqual(EvmMandate.parse(evmMandate()));
    expect(mandateHash(built)).toBe(mandateHash(evmMandate()));
  });

  it("puts the base asset first and doesn't repeat it", () => {
    const built = buildEvmMandate({ ...rules, assets: [TSLA, USDG] });
    const parsed = EvmMandate.parse(evmMandate());
    expect(built.assets).toEqual([parsed.baseAsset, parsed.assets[1]]);
  });

  it("turns function signatures into selectors and leaves out selectors for 'any function'", () => {
    const built = buildEvmMandate({
      ...rules,
      targets: [
        { address: ROUTER, functions: ["swap(address,address,uint256,address)"] },
        { address: AMZN },
      ],
    });
    // keccak256("swap(address,address,uint256,address)")[0:4]
    expect(built.targets[0]?.selectors).toEqual(["0x6e81221c"]);
    expect(built.targets[1]?.selectors).toBeUndefined();
    expect(toEvmMandateParams(built).selectors).toEqual([["0x6e81221c"], []]);
  });

  it("converts percentages to basis points and dollars to 6-decimal units on chain", () => {
    const params = toEvmMandateParams(
      buildEvmMandate({ ...rules, maxDrawdownPct: 12.5, maxSlippagePct: 0.5 }),
    );
    expect(params.maxDrawdownBps).toBe(1_250);
    expect(params.maxSlippageBps).toBe(50);
    expect(params.maxTxNotionalUsd6).toBe(5_000_000_000n);
    expect(params.freezeOnBreach).toBe(true);
  });

  it("rejects rules the vault would refuse, with the schema's message", () => {
    expect(() => buildEvmMandate({ ...rules, maxDailyUsd: 1_000 })).toThrow(/at least/);
    expect(() => buildEvmMandate({ ...rules, maxTradeUsd: 0 })).toThrow();
    expect(() => buildEvmMandate({ ...rules, baseAsset: "0x123" })).toThrow(/invalid EVM address/);
    expect(() =>
      buildEvmMandate({ ...rules, targets: [{ address: ROUTER, functions: ["swap"] }] }),
    ).toThrow(/not a selector or a function signature/);
  });
});

describe("describeMandate", () => {
  const tokens = [
    { symbol: "tUSDG", address: USDG },
    { symbol: "tTSLA", address: TSLA },
  ];
  it("names tokens by symbol and states the limits", () => {
    const text = describeMandate(buildEvmMandate(rules), tokens);
    expect(text).toBe(
      `You manage a vault holding tUSDG, tTSLA, ${EvmMandate.parse(evmMandate()).assets[2]}. ` +
        "You may trade only these tokens, and only through the exchange's swap function. " +
        "You may not send tokens to other addresses or approve other spenders. " +
        "Limits: $5,000 per trade, $25,000 per day.",
    );
  });
  it("lists allowed destinations when there are some", () => {
    const text = describeMandate(buildEvmMandate({ ...rules, destinations: [TSLA] }), tokens);
    expect(text).toContain(
      "You may send tokens only to tTSLA, and may not approve other spenders.",
    );
  });
});
