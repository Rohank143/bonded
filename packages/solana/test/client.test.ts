import { readFileSync } from "node:fs";
import { BorshCoder } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { describe, expect, it } from "vitest";
import {
  address,
  bondedCoverIdl,
  bondedVaultIdl,
  claimable,
  decodePolicy,
  decodeVault,
  fileClaimInstruction,
  type Policy,
  PROGRAM_IDS,
  type Vault,
} from "../src/index.js";

const devnet = JSON.parse(
  readFileSync(
    new URL("../../../contracts/solana/deployments/devnet.json", import.meta.url),
    "utf8",
  ),
) as { programs: Record<string, string>; pool: string };
const key = (seed: number) => new PublicKey(Buffer.alloc(32, seed));

it("uses the deployed program ids and derives the same addresses as the Rust client", () => {
  expect(PROGRAM_IDS.registry.toBase58()).toBe(devnet.programs.bonded_registry);
  expect(PROGRAM_IDS.vault.toBase58()).toBe(devnet.programs.bonded_vault);
  expect(PROGRAM_IDS.cover.toBase58()).toBe(devnet.programs.bonded_cover);
  // bonded-devnet setup (Rust, bonded_client::address::pool_vault) recorded this address.
  expect(address.poolVault().toBase58()).toBe(devnet.pool);
});

describe("decoding accounts from the IDL", () => {
  it("reads a vault and its breach log", async () => {
    const raw = {
      guardian: key(1),
      agent: key(2),
      agent_id: new BN(7),
      mandate_hash: Array(32).fill(7),
      enforce: false,
      freeze_on_breach: true,
      base_mint: key(3),
      base_account: key(4),
      allowed_programs: [key(5)],
      max_outflow_per_call: new BN(5_000_000_000),
      frozen: true,
      breaches: [
        {
          breach_type: { UnauthorizedTransfer: {} },
          blocked: false,
          claimed: false,
          target: key(6),
          timestamp: new BN(1_800_000_000),
          loss: new BN(1_000_000_000),
        },
        {
          breach_type: { Limit: {} },
          blocked: true,
          claimed: false,
          target: key(6),
          timestamp: new BN(1_800_000_100),
          loss: new BN(0),
        },
      ],
      bump: 255,
    };
    const data = await new BorshCoder(bondedVaultIdl).accounts.encode("Vault", raw);
    const v = decodeVault(key(9), data);
    expect(v).toMatchObject({ agentId: 7n, frozen: true });
    expect(v.guardian.equals(key(1))).toBe(true);
    expect(v.breaches.map((b) => [b.id, b.type, b.blocked, b.loss])).toEqual([
      [0, "UnauthorizedTransfer", false, 1_000_000_000n],
      [1, "Limit", true, 0n],
    ]);
  });

  it("reads a policy", async () => {
    const raw = {
      policy_id: new BN(3),
      agent_id: new BN(7),
      vault: key(9),
      cover_amount: new BN(20_000_000_000),
      remaining_cover: new BN(19_100_000_000),
      premium_rate_bps: 434,
      score: 56,
      started_at: new BN(100),
      ends_at: new BN(200),
      active: true,
      bump: 254,
    };
    const data = await new BorshCoder(bondedCoverIdl).accounts.encode("Policy", raw);
    expect(decodePolicy(key(8), data)).toMatchObject({
      policyId: 3n,
      agentId: 7n,
      remainingCover: 19_100_000_000n,
      startedAt: 100,
      endsAt: 200,
      active: true,
    });
  });
});

describe("claimable", () => {
  const vault = (breaches: Partial<Vault["breaches"][number]>[]): Vault => ({
    address: key(9),
    guardian: key(1),
    agent: key(2),
    agentId: 7n,
    baseMint: key(3),
    frozen: true,
    breaches: breaches.map((b, id) => ({
      id,
      type: "UnauthorizedTransfer",
      blocked: false,
      claimed: false,
      target: key(6),
      timestamp: 150,
      loss: 100n,
      ...b,
    })),
  });
  const policy = (p: Partial<Policy> = {}): Policy => ({
    address: key(8),
    policyId: 3n,
    agentId: 7n,
    vault: key(9),
    coverAmount: 1000n,
    remainingCover: 1000n,
    startedAt: 100,
    endsAt: 200,
    active: true,
    ...p,
  });

  it("picks the breaches the program would pay", () => {
    const v = vault([
      {},
      { claimed: true },
      { blocked: true },
      { loss: 0n },
      { timestamp: 50 }, // before the policy
      { timestamp: 250 }, // after it
      { loss: 40n },
    ]);
    const [plan] = claimable([v], [policy()], 210, 30);
    expect(plan!.breachIds).toEqual([0, 6]);
    expect(plan!.loss).toBe(140n);
  });

  it("skips inactive policies, closed claim windows and other vaults", () => {
    const v = vault([{}]);
    expect(claimable([v], [policy({ active: false })], 150, 30)).toEqual([]);
    expect(claimable([v], [policy()], 231, 30)).toEqual([]);
    expect(claimable([v], [policy({ vault: key(10) })], 150, 30)).toEqual([]);
  });
});

it("builds file_claim with the IDL's accounts and discriminator", () => {
  const v: Vault = {
    address: key(9),
    guardian: key(1),
    agent: key(2),
    agentId: 7n,
    baseMint: key(3),
    frozen: true,
    breaches: [],
  };
  const p: Policy = {
    address: key(8),
    policyId: 3n,
    agentId: 7n,
    vault: key(9),
    coverAmount: 1n,
    remainingCover: 1n,
    startedAt: 0,
    endsAt: 1,
    active: true,
  };
  const ix = fileClaimInstruction({ vault: v, policy: p, breachIds: [0, 2], loss: 1n });
  const idlIx = bondedCoverIdl.instructions.find((i) => i.name === "file_claim")!;
  expect(ix.programId.equals(PROGRAM_IDS.cover)).toBe(true);
  expect([...ix.data.subarray(0, 8)]).toEqual(idlIx.discriminator);
  // Vec<u8>: a 4-byte length, then the ids.
  expect([...ix.data.subarray(8)]).toEqual([2, 0, 0, 0, 0, 2]);
  expect(ix.keys).toHaveLength(idlIx.accounts.length);
  expect(ix.keys[1]!.pubkey.equals(p.address)).toBe(true);
  expect(ix.keys[2]!.pubkey.equals(v.address)).toBe(true);
  expect(ix.keys[4]!.pubkey.equals(address.bond(7n))).toBe(true);
  expect(ix.keys.some((k) => k.isSigner)).toBe(false); // anyone can file: no signer but the fee payer
});
