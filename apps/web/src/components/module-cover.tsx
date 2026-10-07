import { useQuery } from "@tanstack/react-query";
import { useAccount, useReadContracts } from "wagmi";
import { coverManagerAbi, mandateModuleAbi } from "@bonded/shared";
import type { Address } from "viem";
import { deployment } from "../config";
import { api } from "../lib/api";
import { MODULE_DEFERRED_NOTE } from "../lib/module";
import { BuyCover } from "../pages/Vault";
import { AddressLink, Card } from "./ui";

/**
 * For an agent protected by a module on its owner's smart account (ERC-7579) rather than a vault:
 * which account, and cover for the module, which has no vault page of its own. Says plainly
 * what cover on a module doesn't pay.
 */
export function ModuleCover({ agentId }: { agentId: string }) {
  const { address } = useAccount();
  const self = useQuery({
    queryKey: ["self-agent", agentId],
    queryFn: () => api.selfAgent(agentId),
  });
  const record = self.data?.registered ? self.data : undefined;
  const module =
    record?.protection === "module" ? (record.vault as Address | undefined) : undefined;
  const reads = useReadContracts({
    contracts: [
      { address: module, abi: mandateModuleAbi, functionName: "account" },
      { address: module, abi: mandateModuleAbi, functionName: "guardian" },
      {
        address: deployment.coverManager,
        abi: coverManagerAbi,
        functionName: "activePolicyOf",
        args: [module ?? "0x0000000000000000000000000000000000000000"],
      },
    ],
    query: { enabled: Boolean(module) },
  });
  if (!module) return null;
  const [account, guardian, active] = reads.data ?? [];
  return (
    <>
      <Card title="Its smart account">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm [&_dd]:text-right [&_dt]:text-muted">
          <dt>Account</dt>
          <dd>{account?.result ? <AddressLink address={account.result} /> : "…"}</dd>
          <dt>Mandate module</dt>
          <dd>
            <AddressLink address={module} />
          </dd>
        </dl>
        <p className="mt-3 text-xs text-muted">{MODULE_DEFERRED_NOTE}</p>
      </Card>
      <BuyCover
        vault={module}
        agentId={BigInt(agentId)}
        isGuardian={Boolean(
          address && guardian?.result && address.toLowerCase() === guardian.result.toLowerCase(),
        )}
        hasActive={Boolean(active?.result)}
      />
    </>
  );
}
