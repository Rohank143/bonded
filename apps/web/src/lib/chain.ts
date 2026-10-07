import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { getAbiItem, type Address, type Hex } from "viem";
import {
  bondedRegistryAbi,
  claimsEngineAbi,
  coverManagerAbi,
  mandateVaultFactoryAbi,
} from "@bonded/shared";
import { deployment } from "../config";

/** A paid claim, as emitted by ClaimsEngine.ClaimPaid (docs/SPECIFICATION.md Section 11.2). */
export interface PaidClaim {
  policyId: bigint;
  vault: Address;
  lossBase: bigint;
  payout: bigint;
  premiumNetted: bigint;
  fromBond: bigint;
  fromPool: bigint;
  breachIds: readonly bigint[];
  txHash: Hex;
  blockNumber: bigint;
}

/**
 * Split a claim into what the vault lost and where the money came from. The unpaid part is
 * the deductible, plus anything above the remaining cover.
 */
export function waterfall(
  c: Pick<PaidClaim, "lossBase" | "payout" | "fromBond" | "fromPool" | "premiumNetted">,
) {
  return {
    loss: c.lossBase,
    unpaid: c.lossBase > c.payout ? c.lossBase - c.payout : 0n,
    fromBond: c.fromBond,
    fromPool: c.fromPool,
    premiumNetted: c.premiumNetted,
    toVault: c.payout - c.premiumNetted,
  };
}

const fromBlock = BigInt(deployment.deployedAtBlock);

/** Every paid claim since the deployment, newest first. */
export function useClaims() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["claims"],
    enabled: Boolean(client),
    refetchInterval: 15_000,
    queryFn: async (): Promise<PaidClaim[]> => {
      const logs = await client!.getLogs({
        address: deployment.claimsEngine,
        event: getAbiItem({ abi: claimsEngineAbi, name: "ClaimPaid" }),
        fromBlock,
        toBlock: "latest",
        strict: true,
      });
      return logs
        .map((l) => ({ ...l.args, txHash: l.transactionHash, blockNumber: l.blockNumber }))
        .reverse();
    },
  });
}

/** Every vault created by the factory, newest first. */
export function useVaults() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["vaults"],
    enabled: Boolean(client),
    queryFn: async () => {
      const logs = await client!.getLogs({
        address: deployment.factory,
        event: getAbiItem({ abi: mandateVaultFactoryAbi, name: "VaultCreated" }),
        fromBlock,
        toBlock: "latest",
        strict: true,
      });
      return logs.map((l) => ({ ...l.args, txHash: l.transactionHash })).reverse();
    },
  });
}

/** Policies bound to one vault, newest first (activePolicyOf only shows the current one). */
export function usePolicies(vault: Address) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["policies", vault],
    enabled: Boolean(client),
    queryFn: async () => {
      const logs = await client!.getLogs({
        address: deployment.coverManager,
        event: getAbiItem({ abi: coverManagerAbi, name: "CoverBound" }),
        args: { vault },
        fromBlock,
        toBlock: "latest",
        strict: true,
      });
      return logs.map((l) => l.args.policyId).reverse();
    },
  });
}

/** One registered agent for the Agents list. */
export interface AgentRow {
  agentId: bigint;
  owner: Address;
  /** The registry score, if the agent has ever been rated. */
  score?: { score: number; expectedLossBps: number; expiresAt: bigint };
  /** The agent's newest vault, if it has one. */
  vault?: Address;
}

/**
 * Join the registry's Registered events, each agent's score and the factory's vaults into one
 * row per agent, newest first. An agent with several vaults shows its newest.
 */
export function agentRows(
  registered: readonly { agentId: bigint; owner: Address }[],
  scores: readonly {
    score: number;
    expectedLossBps: number;
    issuedAt: bigint;
    expiresAt: bigint;
  }[],
  vaults: readonly { agentId: bigint; vault: Address }[],
): AgentRow[] {
  const newestVault = new Map<bigint, Address>();
  for (const v of vaults) newestVault.set(v.agentId, v.vault);
  return registered
    .map((r, i) => {
      const s = scores[i];
      const vault = newestVault.get(r.agentId);
      return {
        agentId: r.agentId,
        owner: r.owner,
        ...(s && s.issuedAt > 0n
          ? {
              score: { score: s.score, expectedLossBps: s.expectedLossBps, expiresAt: s.expiresAt },
            }
          : {}),
        ...(vault ? { vault } : {}),
      };
    })
    .reverse();
}

/** Every agent registered in BondedRegistry, with its score and vault, newest first. */
export function useAgents() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["agents"],
    enabled: Boolean(client),
    refetchInterval: 30_000,
    queryFn: async (): Promise<AgentRow[]> => {
      const [registered, vaults] = await Promise.all([
        client!.getLogs({
          address: deployment.registry,
          event: getAbiItem({ abi: bondedRegistryAbi, name: "Registered" }),
          fromBlock,
          toBlock: "latest",
          strict: true,
        }),
        client!.getLogs({
          address: deployment.factory,
          event: getAbiItem({ abi: mandateVaultFactoryAbi, name: "VaultCreated" }),
          fromBlock,
          toBlock: "latest",
          strict: true,
        }),
      ]);
      // One read per agent; the local demo chain has no multicall contract to batch them.
      const scores = await Promise.all(
        registered.map((r) =>
          client!.readContract({
            address: deployment.registry,
            abi: bondedRegistryAbi,
            functionName: "scoreOf",
            args: [r.args.agentId],
          }),
        ),
      );
      return agentRows(
        registered.map((r) => r.args),
        scores,
        vaults.map((v) => v.args),
      );
    },
  });
}
