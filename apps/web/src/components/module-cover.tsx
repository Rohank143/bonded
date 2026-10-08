import { useAccount, useReadContracts } from "wagmi";
import { coverManagerAbi, mandateModuleAbi } from "@bonded/shared";
import type { Address } from "viem";
import { deployment } from "../config";
import { MODULE_COVER_NOTE } from "../lib/module";
import { moduleCoverNote } from "../lib/chain";
import { Card } from "./ui";
import { BuyCover } from "../pages/Vault";

/**
 * Cover for an agent protected by a module on its owner's smart account (ERC-7579) rather than a
 * vault: the module has no vault page, so its cover form is on the agent's page. Says plainly what
 * cover on a module doesn't pay.
 */
export function ModuleCover({ agentId, module }: { agentId: bigint; module: Address }) {
  const { address } = useAccount();
  const reads = useReadContracts({
    contracts: [
      { address: module, abi: mandateModuleAbi, functionName: "guardian" },
      {
        address: deployment.coverManager,
        abi: coverManagerAbi,
        functionName: "activePolicyOf",
        args: [module],
      },
      { address: module, abi: mandateModuleAbi, functionName: "mode" },
    ],
  });
  const [guardian, active, mode] = reads.data ?? [];
  const note = mode?.result !== undefined ? moduleCoverNote(mode.result) : undefined;
  if (note && !note.insurable)
    return (
      <Card title="Cover">
        <p className="text-sm text-muted">
          This module runs in Monitor mode, so it can't hold cover: a breach would go through and be
          paid to the account's own owner. A new module in Enforce mode can.
        </p>
      </Card>
    );
  return (
    <div className="flex flex-col gap-2">
      <BuyCover
        vault={module}
        agentId={agentId}
        isGuardian={Boolean(
          address && guardian?.result && address.toLowerCase() === guardian.result.toLowerCase(),
        )}
        hasActive={Boolean(active?.result)}
      />
      <p className="px-1 text-xs text-muted">{MODULE_COVER_NOTE}</p>
    </div>
  );
}
