import {
  asEntryPoint,
  deployReferenceAccount,
  deploySafe7579Account,
  type Sandbox,
} from "@bonded/sandbox";
import { bondedRegistryAbi, testTokenAbi } from "@bonded/shared";
import { type Address, parseUnits } from "viem";
import { type BuiltMandate, type EvmMandateRules, installMandateModule } from "../src/index.js";
import { send } from "./chain.js";

/**
 * A smart account guarded by a MandateModule, on the sandbox chain: a real ERC-7579 account
 * (from @bonded/sandbox) whose module is created and installed with the SDK's one-batch install.
 */
export type AccountKind = "msa" | "safe";

export interface ProtectedAccount extends BuiltMandate {
  account: Address;
  module: Address;
  agentId: bigint;
}

/**
 * A new account of `kind` holding 50,000 tUSDG, guarded by a MandateModule (agent key: the
 * sandbox's `agent`) created through the factory and installed as executor and hook, with the
 * same demo-market mandate as the SDK's test vaults.
 */
export async function protectedAccount(
  sandbox: Sandbox,
  kind: AccountKind,
  overrides: Partial<EvmMandateRules> = {},
  options: { install?: boolean } = {},
): Promise<ProtectedAccount> {
  const d = sandbox.deployment;
  if (!d.moduleFactory) throw new Error("this deployment has no MandateModuleFactory");
  const account =
    kind === "msa" ? await deployReferenceAccount(sandbox) : await deploySafe7579Account(sandbox);
  const agentId = (await send(sandbox, "operator", {
    address: d.registry,
    abi: bondedRegistryAbi,
    functionName: "register",
    args: ["ipfs://bonded/sdk-test/module-agent.json"],
  })) as bigint;
  const rules: EvmMandateRules = {
    chainId: sandbox.chain.id,
    agentId,
    mode: "monitor",
    baseAsset: d.usdg,
    assets: [d.tsla, d.nvda],
    targets: [{ address: d.router, functions: ["swap(address,address,uint256,address)"] }],
    maxTradeUsd: 5_000,
    maxDailyUsd: 25_000,
    maxDrawdownPct: 15,
    maxSlippagePct: 3,
    description: "SDK test module: trade tTSLA and tNVDA against tUSDG.",
    ...overrides,
  };
  // The SDK's one-batch install: createModule, then installModule as executor and hook.
  const plan = await installMandateModule(sandbox.publicClient, {
    moduleFactory: d.moduleFactory,
    account,
    accountType: kind === "msa" ? "erc7579" : "safe7579",
    rules,
    agent: sandbox.address("agent"),
    guardian: sandbox.address("operator"),
  });
  if (options.install === false) {
    // Only create it: the account calls the factory itself.
    const asAccount = await sandbox.impersonate(account);
    const call = plan.calls[0];
    const hash = await asAccount.sendTransaction({ to: call.to, data: call.data });
    await sandbox.publicClient.waitForTransactionReceipt({ hash });
  } else {
    // The owner sends the batch, as the EntryPoint would after validating the owner's operation.
    await asEntryPoint(sandbox, account, plan.execute.data);
  }
  const built = {
    mandate: plan.mandate,
    mandateHash: plan.params.mandateHash,
    params: plan.params,
  };
  const module = plan.module;

  // Fund the account.
  const amount = parseUnits("50000", 6);
  await send(sandbox, "depositor", {
    address: d.usdg,
    abi: testTokenAbi,
    functionName: "faucet",
    args: [amount],
  });
  await send(sandbox, "depositor", {
    address: d.usdg,
    abi: testTokenAbi,
    functionName: "transfer",
    args: [account, amount],
  });
  return { ...built, account, module, agentId };
}
