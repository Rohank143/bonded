import { expect, it } from "vitest";
import { waterfall } from "./chain";

it("splits the Gate 1 testnet claim like the contract did", () => {
  // ClaimPaid for policy 1 on chain 46630 (docs/progress/DAY-07.md).
  expect(
    waterfall({
      lossBase: 1_000_000_000n,
      payout: 900_000_000n,
      fromBond: 900_000_000n,
      fromPool: 0n,
      premiumNetted: 0n,
    }),
  ).toEqual({
    loss: 1_000_000_000n,
    unpaid: 100_000_000n,
    fromBond: 900_000_000n,
    fromPool: 0n,
    premiumNetted: 0n,
    toVault: 900_000_000n,
  });
});

it("nets owed premium out of what reaches the vault", () => {
  const w = waterfall({
    lossBase: 5_000n,
    payout: 4_500n,
    fromBond: 1_000n,
    fromPool: 3_500n,
    premiumNetted: 200n,
  });
  expect(w.toVault).toBe(4_300n);
  expect(w.fromBond + w.fromPool).toBe(4_500n);
});
