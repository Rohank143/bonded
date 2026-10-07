import { readFileSync } from "node:fs";
import { BorshCoder } from "@anchor-lang/core";
import { Ed25519Program, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { describe, expect, it } from "vitest";
import {
  address,
  attestationMessage,
  bondedCoverIdl,
  bondedVaultIdl,
  claimable,
  createVaultInstruction,
  decodePolicy,
  decodeVault,
  depositInstruction,
  executeInstruction,
  fileClaimInstruction,
  type Policy,
  PROGRAM_IDS,
  postScoreInstructions,
  registerInstruction,
  TOKEN_PROGRAM,
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
    expect(v).toMatchObject({
      agentId: 7n,
      frozen: true,
      enforce: false,
      freezeOnBreach: true,
      maxOutflowPerCall: 5_000_000_000n,
    });
    expect(v.baseAccount.equals(key(4))).toBe(true);
    expect(v.allowedPrograms.map((p) => p.toBase58())).toEqual([key(5).toBase58()]);
    expect([...v.mandateHash]).toEqual(Array(32).fill(7));
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

describe("registry scores", () => {
  const attestation = {
    agentId: 2n,
    score: 56,
    expectedLossBps: 415,
    reportHash: new Uint8Array(32).fill(1),
    mandateHash: new Uint8Array(32).fill(2),
    codeHash: new Uint8Array(32).fill(3),
    teeMeasurement: new Uint8Array(32),
    modelFamily: 6,
    issuedAt: 1_790_603_796,
    expiresAt: 1_793_195_796,
  };

  it("signs the domain tag, the registry's id and the Borsh-encoded attestation", () => {
    const m = attestationMessage(attestation);
    expect(m.subarray(0, 21).toString()).toBe("bonded-attestation-v1");
    expect(m.subarray(21, 53).equals(PROGRAM_IDS.registry.toBuffer())).toBe(true);
    // u64 + u16 + u32 + 4 × 32 bytes + u8 + i64 + i64, little-endian.
    expect(m.length).toBe(53 + 8 + 2 + 4 + 128 + 1 + 8 + 8);
    expect(m.readBigUInt64LE(53)).toBe(2n);
    expect(m.readUInt16LE(61)).toBe(56);
    expect(m.readUInt32LE(63)).toBe(415);
    expect(m.readBigInt64LE(m.length - 8)).toBe(1_793_195_796n);
  });

  it("puts the attester's Ed25519 check just before post_score", () => {
    const attester = Keypair.generate();
    const [verify, post] = postScoreInstructions(attestation, attester);
    expect(verify!.programId.equals(Ed25519Program.programId)).toBe(true);
    // The check covers the attester's key and exactly the attestation message.
    expect(verify!.data.subarray(16, 48).equals(attester.publicKey.toBuffer())).toBe(true);
    expect(verify!.data.subarray(112).equals(attestationMessage(attestation))).toBe(true);
    expect(post!.programId.equals(PROGRAM_IDS.registry)).toBe(true);
    expect(post!.keys[1]!.pubkey.equals(address.agent(2n))).toBe(true);
  });

  it("registers the next agent id with its owner signing", () => {
    const owner = Keypair.generate().publicKey;
    const ix = registerInstruction(owner, 3n, "bonded://robinhoodTestnet/agent/2");
    expect(ix.keys[1]!.pubkey.equals(address.agent(3n))).toBe(true);
    expect(ix.keys.find((k) => k.pubkey.equals(owner))).toMatchObject({
      isSigner: true,
      isWritable: true,
    });
  });
});

describe("vault instructions", () => {
  const coder = new BorshCoder(bondedVaultIdl);
  const guardian = key(1);
  const agent = key(2);
  const mint = key(3);

  it("creates a vault at the guardian's PDA for the agent id, with the params encoded", () => {
    const ix = createVaultInstruction(guardian, mint, {
      agentId: 7n,
      agent,
      mandateHash: new Uint8Array(32).fill(9),
      enforce: true,
      freezeOnBreach: true,
      allowedPrograms: [TOKEN_PROGRAM],
      maxOutflowPerCall: 1_000n,
    });
    const vault = address.vault(guardian, 7n);
    expect(ix.keys[0]!.pubkey.equals(vault)).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(address.vaultBase(vault))).toBe(true);
    const decoded = coder.instruction.decode(ix.data) as {
      name: string;
      data: { params: { agent: PublicKey; enforce: boolean; max_outflow_per_call: BN } };
    };
    expect(decoded.name).toBe("create_vault");
    expect(decoded.data.params.agent.equals(agent)).toBe(true);
    expect(decoded.data.params.enforce).toBe(true);
    expect(decoded.data.params.max_outflow_per_call.toString()).toBe("1000");
  });

  it("deposits into the vault's base account", () => {
    const vault = address.vault(guardian, 7n);
    const ix = depositInstruction({ address: vault, baseMint: mint }, key(4), key(5), 25n);
    expect(ix.keys[1]!.pubkey.equals(address.vaultBase(vault))).toBe(true);
    expect((coder.instruction.decode(ix.data) as { name: string }).name).toBe("deposit");
  });

  it("wraps an instruction in execute: agent signs, the inner accounts follow, the vault never signs", () => {
    const vault = address.vault(guardian, 7n);
    const inner = new TransactionInstruction({
      programId: TOKEN_PROGRAM,
      data: Buffer.from([12, 1, 2, 3]),
      keys: [
        { pubkey: key(4), isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: true, isWritable: false },
      ],
    });
    const ix = executeInstruction({ address: vault, agent }, inner);
    expect(ix.programId.equals(PROGRAM_IDS.vault)).toBe(true);
    expect(ix.keys.slice(0, 4).map((k) => k.pubkey.toBase58())).toEqual([
      vault.toBase58(),
      agent.toBase58(),
      address.vaultBase(vault).toBase58(),
      TOKEN_PROGRAM.toBase58(),
    ]);
    expect(ix.keys[1]!.isSigner).toBe(true);
    expect(ix.keys.slice(4)).toEqual([
      { pubkey: key(4), isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
    ]);
    const decoded = coder.instruction.decode(ix.data) as { name: string; data: { data: Buffer } };
    expect(decoded.name).toBe("execute");
    expect([...decoded.data.data]).toEqual([12, 1, 2, 3]);
  });
});
