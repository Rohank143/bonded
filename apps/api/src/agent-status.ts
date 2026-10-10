import type { Database } from "@bonded/db";
import type { ServiceChain } from "@bonded/keeper";
import { agentGasStatus, coverManagerAbi, mandateVaultAbi, type AgentGas } from "@bondedhq/shared";
import type { Address } from "viem";

/**
 * What an agent's vault (or smart-account module) is doing, from the chain and the keeper's
 * index of its events: its trades through `execute`, the agent key's gas, and its cover. All of it
 * is public on chain, so it can be shown with the agent's public record; it is cached briefly so
 * a page view isn't a handful of RPC calls each time.
 */

/** No trade through the vault in this long, while cover is active: `coverWithoutVaultTrades`. */
export const VAULT_TRADE_WINDOW_MS = 7 * 86_400_000;

/** CoverManager's policy statuses (ICoverManager.Status). */
const POLICY_STATUS = ["none", "active", "cancelled", "expired", "lapsed", "exhausted"] as const;

export interface VaultTradingStatus {
  firstTradeAt: string | null;
  lastTradeAt: string | null;
  trades24h: number;
  trades7d: number;
  total: number;
  lastTxHash: string | null;
}

export interface CoverStatus {
  policyId: string;
  status: (typeof POLICY_STATUS)[number];
  active: boolean;
  /** Base-asset units (6 decimals), as decimal strings. */
  coverAmount: string;
  remainingCover: string;
  endsAt: string;
  paidUntil: string;
  /** Set while a premium collection has failed: the grace period runs from here. */
  pastDueSince: string | null;
  /** When the cover lapses if the premium stays unpaid (pastDueSince + grace period). */
  lapsesAt: string | null;
}

export interface AgentChainStatus {
  vault: string;
  /** The vault's agent key (it pays gas for every trade). */
  agentKey: string | null;
  frozen: boolean | null;
  vaultActivity: VaultTradingStatus;
  agentGas: AgentGas | null;
  /** The vault's active policy, or else its latest one (lapsed, expired, ...); null if none. */
  cover: CoverStatus | null;
  /** Active cover, and no trade through the vault in the last 7 days (or ever). */
  coverWithoutVaultTrades: boolean;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const time = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();

/** Reads a vault's status; cached per vault for `ttlMs` (default 30 s). */
export class AgentStatusReader {
  private readonly cache = new Map<string, { at: number; value: Promise<AgentChainStatus> }>();

  constructor(
    private readonly db: Database,
    private readonly chain: ServiceChain,
    private readonly options: { ttlMs?: number; now?: () => number } = {},
  ) {}

  read(vault: string): Promise<AgentChainStatus> {
    const now = (this.options.now ?? Date.now)();
    const key = vault.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < (this.options.ttlMs ?? 30_000)) return hit.value;
    if (this.cache.size > 2_000) this.cache.clear();
    const value = this.load(key as Address, now);
    // A failed read isn't kept: the next view tries again.
    value.catch(() => this.cache.delete(key));
    this.cache.set(key, { at: now, value });
    return value;
  }

  private async latestPolicyOf(vault: Address): Promise<bigint | undefined> {
    const row = (
      await this.db.pool.query(
        "SELECT max(policy_id)::text AS id FROM keeper_policies WHERE chain_id=$1 AND vault=$2",
        [this.chain.deployment.chainId, vault.toLowerCase()],
      )
    ).rows[0] as { id: string | null } | undefined;
    return row?.id ? BigInt(row.id) : undefined;
  }

  private async load(vault: Address, nowMs: number): Promise<AgentChainStatus> {
    const { read, deployment: d } = this.chain;
    const call = <T>(functionName: string, address: Address = vault, args: unknown[] = []) =>
      read
        .readContract({
          address,
          abi: address === vault ? mandateVaultAbi : coverManagerAbi,
          functionName,
          args,
        } as never)
        .then((v) => v as T)
        .catch(() => undefined);
    const [activity, agentKey, frozen, activePolicyId, grace, gasPrice] = await Promise.all([
      this.db.vaultActivity(d.chainId, vault, new Date(nowMs)),
      call<Address>("agent"),
      call<boolean>("frozen"),
      call<bigint>("activePolicyOf", d.coverManager, [vault]),
      call<bigint>("gracePeriod", d.coverManager),
      read.getGasPrice().catch(() => null),
    ]);
    // CoverManager clears activePolicyOf when a policy closes (lapsed, expired, cancelled), so a
    // lapsed cover would read as none. Without an active one, show the vault's latest policy from
    // the keeper's index of CoverBound events, with its closed status.
    const policyId =
      activePolicyId && activePolicyId > 0n
        ? activePolicyId
        : activePolicyId === undefined
          ? undefined
          : await this.latestPolicyOf(vault);
    const balance = agentKey
      ? await read.getBalance({ address: agentKey }).catch(() => null)
      : null;
    const policy =
      policyId && policyId > 0n
        ? await call<{
            coverAmount: bigint;
            remainingCover: bigint;
            status: number;
            endsAt: bigint;
            paidUntil: bigint;
            pastDueSince: bigint;
          }>("getPolicy", d.coverManager, [policyId])
        : undefined;
    const cover: CoverStatus | null =
      policy && policyId
        ? {
            policyId: policyId.toString(),
            status: POLICY_STATUS[policy.status] ?? "none",
            active: policy.status === 1,
            coverAmount: policy.coverAmount.toString(),
            remainingCover: policy.remainingCover.toString(),
            endsAt: time(policy.endsAt),
            paidUntil: time(policy.paidUntil),
            pastDueSince: policy.pastDueSince > 0n ? time(policy.pastDueSince) : null,
            lapsesAt:
              policy.pastDueSince > 0n && grace !== undefined
                ? time(policy.pastDueSince + grace)
                : null,
          }
        : null;
    const last = activity.lastTradeAt?.getTime();
    return {
      vault,
      agentKey: agentKey?.toLowerCase() ?? null,
      frozen: frozen ?? null,
      vaultActivity: {
        firstTradeAt: iso(activity.firstTradeAt),
        lastTradeAt: iso(activity.lastTradeAt),
        trades24h: activity.trades24h,
        trades7d: activity.trades7d,
        total: activity.total,
        lastTxHash: activity.lastTxHash,
      },
      agentGas:
        balance === null
          ? null
          : agentGasStatus({
              balanceWei: balance,
              gasPriceWei: gasPrice,
              measuredGasPerTrade: activity.medianGas,
            }),
      cover,
      coverWithoutVaultTrades:
        cover?.active === true && (last === undefined || nowMs - last > VAULT_TRADE_WINDOW_MS),
    };
  }
}
