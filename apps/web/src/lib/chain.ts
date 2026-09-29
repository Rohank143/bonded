import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { getAbiItem, type Address, type Hex } from "viem";
import { claimsEngineAbi, coverManagerAbi, mandateVaultFactoryAbi } from "@bonded/shared";
import { deployment } from "../config";

/** A paid claim, as emitted by ClaimsEngine.ClaimPaid (docs/PLAN.md Section 11.2). */
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
