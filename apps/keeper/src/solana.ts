import {
  type ClaimPlan,
  type CoverConfig,
  claimable,
  fetchCoverConfig,
  fetchPolicies,
  fetchVaults,
  fileClaimInstruction,
  type Policy,
  type Vault,
} from "@bondedhq/solana";
import {
  Connection,
  Keypair,
  sendAndConfirmTransaction,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

/**
 * The Solana keeper (docs/decisions/011-solana-programs.md): it files claims for covered
 * breaches, as the EVM keeper does. It keeps no state of its own: each vault's on-chain breach
 * log records what is claimed, and the cover program refuses a second claim. Claims are
 * permissionless, so its key only pays transaction fees.
 */

export interface SolanaClaimChain {
  /** The cluster's clock, in unix seconds (what the program compares against). */
  now(): Promise<number>;
  state(): Promise<{ vaults: Vault[]; policies: Policy[]; config: CoverConfig }>;
  send(instruction: TransactionInstruction): Promise<string>;
}

export interface EventPublisher {
  publish(topic: string, payload: unknown): Promise<void>;
}

/**
 * Parse a keeper key: the JSON array `solana-keygen` writes (64 numbers). Kept as a secret on
 * Railway, never in the repository.
 */
export function parseSolanaKey(secret: string): Keypair {
  const bytes = JSON.parse(secret) as unknown;
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => Number.isInteger(b)))
    throw new Error("SOLANA_KEEPER_KEY must be the 64-number JSON array solana-keygen writes");
  return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
}

export function connectSolana(rpcUrl: string, payer: Keypair): SolanaClaimChain {
  const connection = new Connection(rpcUrl, "confirmed");
  return {
    async now() {
      const time = await connection.getBlockTime(await connection.getSlot("confirmed"));
      if (time === null) throw new Error("the cluster reported no block time");
      return time;
    },
    async state() {
      const [vaults, policies, config] = await Promise.all([
        fetchVaults(connection),
        fetchPolicies(connection),
        fetchCoverConfig(connection),
      ]);
      return { vaults, policies, config };
    },
    send: (instruction) =>
      sendAndConfirmTransaction(connection, new Transaction().add(instruction), [payer], {
        commitment: "confirmed",
      }),
  };
}

const describePlan = (plan: ClaimPlan) => ({
  vault: plan.vault.address.toBase58(),
  policyId: plan.policy.policyId.toString(),
  agentId: plan.policy.agentId.toString(),
  breachIds: plan.breachIds,
  loss: plan.loss.toString(),
});

export class SolanaKeeper {
  constructor(
    private readonly events: EventPublisher,
    private readonly chain: SolanaClaimChain,
  ) {}

  /** File every claim the cover program would accept now. One failed claim doesn't stop the rest. */
  async tick(): Promise<{ filed: number; failed: number }> {
    const [now, { vaults, policies, config }] = await Promise.all([
      this.chain.now(),
      this.chain.state(),
    ]);
    let filed = 0;
    let failed = 0;
    for (const plan of claimable(vaults, policies, now, config.claimWindow)) {
      try {
        const signature = await this.chain.send(fileClaimInstruction(plan));
        await this.events.publish("solana.claim.paid", { ...describePlan(plan), signature });
        filed++;
      } catch (error) {
        await this.events.publish("solana.claim.failed", {
          ...describePlan(plan),
          error: error instanceof Error ? error.message.slice(0, 500) : String(error),
        });
        failed++;
      }
    }
    return { filed, failed };
  }
}
