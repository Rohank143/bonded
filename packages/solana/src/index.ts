import { BorshCoder, type Idl } from "@anchor-lang/core";
import {
  type AccountMeta,
  type Connection,
  Ed25519Program,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import { bondedCoverIdl, bondedRegistryIdl, bondedVaultIdl } from "./idls.js";

/**
 * TypeScript client for the Bonded Solana programs (docs/decisions/011-solana-programs.md).
 * Accounts are decoded and instructions encoded from the programs' own IDLs (src/idls.ts,
 * generated from the Anchor build), so layouts can't drift from the Rust. The Rust twin is
 * contracts/solana/crates/bonded_client; both derive the same addresses.
 */

export { bondedCoverIdl, bondedRegistryIdl, bondedVaultIdl };

export const PROGRAM_IDS = {
  registry: new PublicKey(bondedRegistryIdl.address),
  vault: new PublicKey(bondedVaultIdl.address),
  cover: new PublicKey(bondedCoverIdl.address),
} as const;

export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM_PROGRAM = SystemProgram.programId;

const coders = {
  vault: new BorshCoder(bondedVaultIdl),
  cover: new BorshCoder(bondedCoverIdl),
  registry: new BorshCoder(bondedRegistryIdl),
};

const u64 = (n: bigint | number) => new BN(n.toString()).toArrayLike(Buffer, "le", 8);
const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];

/** Program-derived addresses, with the same seeds as the programs and bonded_client. */
export const address = {
  registryConfig: () => pda([Buffer.from("config")], PROGRAM_IDS.registry),
  agent: (agentId: bigint) => pda([Buffer.from("agent"), u64(agentId)], PROGRAM_IDS.registry),
  vaultConfig: () => pda([Buffer.from("config")], PROGRAM_IDS.vault),
  vault: (guardian: PublicKey, agentId: bigint) =>
    pda([Buffer.from("vault"), guardian.toBuffer(), u64(agentId)], PROGRAM_IDS.vault),
  vaultBase: (vault: PublicKey) => pda([Buffer.from("base"), vault.toBuffer()], PROGRAM_IDS.vault),
  coverConfig: () => pda([Buffer.from("config")], PROGRAM_IDS.cover),
  poolVault: () => pda([Buffer.from("pool_vault")], PROGRAM_IDS.cover),
  claimsAuthority: () => pda([Buffer.from("claims")], PROGRAM_IDS.cover),
  bond: (agentId: bigint) => pda([Buffer.from("bond"), u64(agentId)], PROGRAM_IDS.cover),
  bondVault: (agentId: bigint) => pda([Buffer.from("bond_vault"), u64(agentId)], PROGRAM_IDS.cover),
  policy: (policyId: bigint) => pda([Buffer.from("policy"), u64(policyId)], PROGRAM_IDS.cover),
};

// ---------------------------------------------------------------- decoded accounts

export interface Breach {
  /** The breach's index in the vault's log: what a claim names. */
  id: number;
  type: string;
  blocked: boolean;
  claimed: boolean;
  target: PublicKey;
  timestamp: number;
  /** Base-asset units that left the vault. */
  loss: bigint;
}

export interface Vault {
  address: PublicKey;
  guardian: PublicKey;
  agent: PublicKey;
  agentId: bigint;
  baseMint: PublicKey;
  frozen: boolean;
  breaches: Breach[];
}

export interface Policy {
  address: PublicKey;
  policyId: bigint;
  agentId: bigint;
  vault: PublicKey;
  coverAmount: bigint;
  remainingCover: bigint;
  startedAt: number;
  endsAt: number;
  active: boolean;
}

export interface CoverConfig {
  baseMint: PublicKey;
  claimWindow: number;
  nextPolicyId: bigint;
}

type Raw = Record<string, unknown>;
const big = (v: unknown) => BigInt((v as BN).toString());
const num = (v: unknown) => Number((v as BN).toString());

export function decodeVault(address: PublicKey, data: Buffer): Vault {
  const v = coders.vault.accounts.decode("Vault", data) as Raw;
  return {
    address,
    guardian: v.guardian as PublicKey,
    agent: v.agent as PublicKey,
    agentId: big(v.agent_id),
    baseMint: v.base_mint as PublicKey,
    frozen: v.frozen as boolean,
    breaches: (v.breaches as Raw[]).map((b, id) => ({
      id,
      type: Object.keys(b.breach_type as object)[0]!,
      blocked: b.blocked as boolean,
      claimed: b.claimed as boolean,
      target: b.target as PublicKey,
      timestamp: num(b.timestamp),
      loss: big(b.loss),
    })),
  };
}

export function decodePolicy(address: PublicKey, data: Buffer): Policy {
  const p = coders.cover.accounts.decode("Policy", data) as Raw;
  return {
    address,
    policyId: big(p.policy_id),
    agentId: big(p.agent_id),
    vault: p.vault as PublicKey,
    coverAmount: big(p.cover_amount),
    remainingCover: big(p.remaining_cover),
    startedAt: num(p.started_at),
    endsAt: num(p.ends_at),
    active: p.active as boolean,
  };
}

export function decodeCoverConfig(data: Buffer): CoverConfig {
  const c = coders.cover.accounts.decode("Config", data) as Raw;
  return {
    baseMint: c.base_mint as PublicKey,
    claimWindow: num(c.claim_window),
    nextPolicyId: big(c.next_policy_id),
  };
}

// ---------------------------------------------------------------- reading the chain

/** Every account of one type a program owns, found by its Anchor discriminator. */
async function accountsOf(connection: Connection, idl: Idl, program: PublicKey, name: string) {
  const discriminator = idl.accounts!.find((a) => a.name === name)!.discriminator;
  return connection.getProgramAccounts(program, {
    filters: [{ memcmp: { offset: 0, bytes: bs58(Buffer.from(discriminator)) } }],
  });
}

function bs58(bytes: Buffer): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${bytes.toString("hex") || "0"}`);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export async function fetchVaults(connection: Connection): Promise<Vault[]> {
  const accounts = await accountsOf(connection, bondedVaultIdl, PROGRAM_IDS.vault, "Vault");
  return accounts.map((a) => decodeVault(a.pubkey, a.account.data));
}

export async function fetchPolicies(connection: Connection): Promise<Policy[]> {
  const accounts = await accountsOf(connection, bondedCoverIdl, PROGRAM_IDS.cover, "Policy");
  return accounts.map((a) => decodePolicy(a.pubkey, a.account.data));
}

export async function fetchCoverConfig(connection: Connection): Promise<CoverConfig> {
  const info = await connection.getAccountInfo(address.coverConfig());
  if (!info) throw new Error("the cover program isn't initialized on this cluster");
  return decodeCoverConfig(info.data);
}

// ---------------------------------------------------------------- claims

export interface ClaimPlan {
  vault: Vault;
  policy: Policy;
  breachIds: number[];
  loss: bigint;
}

/**
 * The claims the cover program would accept now, applying its own rules: the policy is active
 * and its claim window open, and each breach is unclaimed, not blocked, lost something and
 * happened within the policy's term. One plan per vault and policy.
 */
export function claimable(
  vaults: readonly Vault[],
  policies: readonly Policy[],
  now: number,
  claimWindow: number,
): ClaimPlan[] {
  const plans: ClaimPlan[] = [];
  for (const policy of policies) {
    if (!policy.active || now > policy.endsAt + claimWindow) continue;
    const vault = vaults.find((v) => v.address.equals(policy.vault));
    if (!vault) continue;
    const breaches = vault.breaches.filter(
      (b) =>
        !b.claimed &&
        !b.blocked &&
        b.loss > 0n &&
        b.timestamp >= policy.startedAt &&
        b.timestamp <= policy.endsAt,
    );
    if (breaches.length === 0) continue;
    plans.push({
      vault,
      policy,
      breachIds: breaches.map((b) => b.id),
      loss: breaches.reduce((s, b) => s + b.loss, 0n),
    });
  }
  return plans;
}

/** The accounts an instruction takes, in the IDL's order, with its writable and signer flags. */
function metas(idl: Idl, instruction: string, accounts: Record<string, PublicKey>): AccountMeta[] {
  const ix = idl.instructions.find((i) => i.name === instruction)!;
  return ix.accounts.map((a) => {
    const account = a as { name: string; writable?: boolean; signer?: boolean };
    const pubkey = accounts[account.name];
    if (!pubkey) throw new Error(`${instruction}: no address for account ${account.name}`);
    return { pubkey, isWritable: !!account.writable, isSigner: !!account.signer };
  });
}

/** File a claim for `plan`. Anyone can send it; the payout goes to the vault. */
export function fileClaimInstruction(plan: ClaimPlan): TransactionInstruction {
  const { vault, policy } = plan;
  const data = coders.cover.instruction.encode("file_claim", {
    breach_ids: Buffer.from(plan.breachIds),
  });
  return new TransactionInstruction({
    programId: PROGRAM_IDS.cover,
    data,
    keys: metas(bondedCoverIdl, "file_claim", {
      config: address.coverConfig(),
      policy: policy.address,
      vault: vault.address,
      vault_base: address.vaultBase(vault.address),
      bond: address.bond(policy.agentId),
      bond_vault: address.bondVault(policy.agentId),
      pool_vault: address.poolVault(),
      base_mint: vault.baseMint,
      claims_authority: address.claimsAuthority(),
      vault_config: address.vaultConfig(),
      vault_program: PROGRAM_IDS.vault,
      token_program: TOKEN_PROGRAM,
    }),
  });
}

// ---------------------------------------------------------------- registry (scores)

/** A score as the Solana registry stores it: the EVM `BondedTypes.Attestation` fields. */
export interface SolanaAttestation {
  agentId: bigint;
  score: number;
  expectedLossBps: number;
  reportHash: Uint8Array;
  mandateHash: Uint8Array;
  codeHash: Uint8Array;
  teeMeasurement: Uint8Array;
  modelFamily: number;
  issuedAt: number;
  expiresAt: number;
}

export interface RegistryAgent {
  agentId: bigint;
  owner: PublicKey;
  uri: string;
  score: SolanaAttestation | null;
}

/** Domain tag the registry prefixes to every signed attestation (bonded_registry). */
export const ATTESTATION_DOMAIN = Buffer.from("bonded-attestation-v1");

const toRaw = (a: SolanaAttestation) => ({
  agent_id: new BN(a.agentId.toString()),
  score: a.score,
  expected_loss_bps: a.expectedLossBps,
  report_hash: [...a.reportHash],
  mandate_hash: [...a.mandateHash],
  code_hash: [...a.codeHash],
  tee_measurement: [...a.teeMeasurement],
  model_family: a.modelFamily,
  issued_at: new BN(a.issuedAt),
  expires_at: new BN(a.expiresAt),
});

const fromRaw = (r: Raw): SolanaAttestation => ({
  agentId: big(r.agent_id),
  score: r.score as number,
  expectedLossBps: r.expected_loss_bps as number,
  reportHash: Uint8Array.from(r.report_hash as number[]),
  mandateHash: Uint8Array.from(r.mandate_hash as number[]),
  codeHash: Uint8Array.from(r.code_hash as number[]),
  teeMeasurement: Uint8Array.from(r.tee_measurement as number[]),
  modelFamily: r.model_family as number,
  issuedAt: num(r.issued_at),
  expiresAt: num(r.expires_at),
});

/**
 * The exact bytes the attester signs: the domain tag, the registry's program id, then the
 * Borsh-encoded attestation (bonded_registry::attestation_message).
 */
export function attestationMessage(attestation: SolanaAttestation): Buffer {
  return Buffer.concat([
    ATTESTATION_DOMAIN,
    PROGRAM_IDS.registry.toBuffer(),
    coders.registry.types.encode("Attestation", toRaw(attestation)),
  ]);
}

export async function fetchRegistryConfig(
  connection: Connection,
): Promise<{ attester: PublicKey; agentCount: bigint }> {
  const info = await connection.getAccountInfo(address.registryConfig());
  if (!info) throw new Error("the registry isn't initialized on this cluster");
  const c = coders.registry.accounts.decode("Config", info.data) as Raw;
  return { attester: c.attester as PublicKey, agentCount: big(c.agent_count) };
}

export async function fetchAgent(
  connection: Connection,
  agentId: bigint,
): Promise<RegistryAgent | null> {
  const info = await connection.getAccountInfo(address.agent(agentId));
  if (!info) return null;
  const a = coders.registry.accounts.decode("Agent", info.data) as Raw;
  return {
    agentId: big(a.agent_id),
    owner: a.owner as PublicKey,
    uri: a.uri as string,
    score: a.score ? fromRaw(a.score as Raw) : null,
  };
}

/** Register the next agent (id = agent count + 1), owned by `owner`, who signs and pays. */
export function registerInstruction(
  owner: PublicKey,
  nextAgentId: bigint,
  uri: string,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_IDS.registry,
    data: coders.registry.instruction.encode("register", { uri }),
    keys: metas(bondedRegistryIdl, "register", {
      config: address.registryConfig(),
      agent: address.agent(nextAgentId),
      owner,
      system_program: SYSTEM_PROGRAM,
    }),
  });
}

/**
 * Post a score: the Ed25519 check of the attester's signature over `attestationMessage`, then
 * the registry instruction, which looks for that check just before it.
 */
export function postScoreInstructions(
  attestation: SolanaAttestation,
  attester: { publicKey: PublicKey; secretKey: Uint8Array },
): TransactionInstruction[] {
  const verify = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: attester.secretKey,
    message: attestationMessage(attestation),
  });
  const post = new TransactionInstruction({
    programId: PROGRAM_IDS.registry,
    data: coders.registry.instruction.encode("post_score", { attestation: toRaw(attestation) }),
    keys: metas(bondedRegistryIdl, "post_score", {
      config: address.registryConfig(),
      agent: address.agent(attestation.agentId),
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    }),
  });
  return [verify, post];
}
