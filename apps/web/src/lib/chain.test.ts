import { expect, it } from "vitest";
import { agentRows, waterfall } from "./chain";

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

it("lists agents newest first, with their score and newest vault", () => {
  const a = "0x00000000000000000000000000000000000000aa" as const;
  const b = "0x00000000000000000000000000000000000000bb" as const;
  const v1 = "0x0000000000000000000000000000000000000001" as const;
  const v2 = "0x0000000000000000000000000000000000000002" as const;
  const rated = { score: 49, expectedLossBps: 511, issuedAt: 100n, expiresAt: 200n };
  const unrated = { score: 0, expectedLossBps: 0, issuedAt: 0n, expiresAt: 0n };
  const rows = agentRows(
    [
      { agentId: 1n, owner: a },
      { agentId: 2n, owner: b },
    ],
    [rated, unrated],
    [
      { agentId: 1n, vault: v1 },
      { agentId: 1n, vault: v2 },
    ],
  );
  expect(rows).toEqual([
    { agentId: 2n, owner: b },
    {
      agentId: 1n,
      owner: a,
      score: { score: 49, expectedLossBps: 511, expiresAt: 200n },
      vault: v2,
    },
  ]);
});
