import { describe, expect, it } from "vitest";
import { mandateCommitment, withMandateCommitment, type EvmMandateParams } from "../src/index.js";

// Same params as test_CommitmentMatchesTheSharedVector in
// contracts/evm/test/module/MandateModuleFactory.t.sol: both languages must agree.
// mandateHash is keccak256("ignored"), as in the Solidity test; the commitment ignores it.
const params: EvmMandateParams = {
  mandateHash: "0x0923f36e3945f5cc209c5027a343234ac33e8f35932bd0f9fd8cb73caad5c142",
  mode: 1,
  baseAsset: "0x1111111111111111111111111111111111111111",
  assets: [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
  ],
  targets: [
    "0x3333333333333333333333333333333333333333",
    "0x4444444444444444444444444444444444444444",
  ],
  selectors: [["0x095ea7b3", "0x38ed1739"], []],
  destinations: ["0x5555555555555555555555555555555555555555"],
  maxTxNotionalUsd6: 5_000_000_000n,
  maxDailyNotionalUsd6: 25_000_000_000n,
  maxDrawdownBps: 1500,
  maxSlippageBps: 300,
  freezeOnBreach: true,
};
const SOLIDITY_COMMITMENT = "0xf35ce1ba75a11d5bc3c77a75643f77300ebd03cdb6b1698fdc676901d52b8b46";

describe("mandateCommitment", () => {
  it("matches the Solidity commitment for the shared vector", () => {
    expect(mandateCommitment(params)).toBe(SOLIDITY_COMMITMENT);
  });

  it("ignores the declared mandate hash", () => {
    expect(mandateCommitment({ ...params, mandateHash: `0x${"00".repeat(32)}` })).toBe(
      SOLIDITY_COMMITMENT,
    );
  });

  it("changes when any enforced rule changes", () => {
    expect(mandateCommitment({ ...params, maxTxNotionalUsd6: 5_000_000_001n })).not.toBe(
      SOLIDITY_COMMITMENT,
    );
    expect(mandateCommitment({ ...params, mode: 0 })).not.toBe(SOLIDITY_COMMITMENT);
    expect(mandateCommitment({ ...params, selectors: [["0x095ea7b3"], []] })).not.toBe(
      SOLIDITY_COMMITMENT,
    );
  });

  it("withMandateCommitment sets the hash and keeps the rules", () => {
    const committed = withMandateCommitment(params);
    expect(committed.mandateHash).toBe(SOLIDITY_COMMITMENT);
    expect({ ...committed, mandateHash: params.mandateHash }).toEqual(params);
  });
});
