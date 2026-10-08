import {
  type ContractReader,
  type EvmMandate,
  type EvmMandateRules,
  type ModuleAccountType,
  type ModuleInstallPlan,
  prepareModuleInstall,
} from "@bonded/shared";
import type { Address } from "viem";
import { buildMandate } from "./mandate.js";

export type { ModuleAccountType, ModuleInstallPlan };

export interface InstallMandateModuleInput {
  /** MandateModuleFactory (`moduleFactory` in the deployment file). */
  moduleFactory: Address;
  /** The smart account to protect; it sends the batch, so it becomes the module's account. */
  account: Address;
  /** "safe7579" for a Safe with Safe7579; "erc7579" for an account like the reference one. */
  accountType: ModuleAccountType;
  /** The mandate in plain rules (dollars, percentages), as for `buildMandate`. */
  rules: EvmMandateRules;
  /** The agent's session key: the only key that can call the module's `execute`. */
  agent: Address;
  /** Can freeze, unfreeze and rotate the agent; must own the agent id to buy cover. */
  guardian: Address;
}

/**
 * Everything a smart account needs to put an agent's mandate on itself in one transaction:
 * create its MandateModule through the factory, and install it as executor (type 2) and hook
 * (type 4). Nothing is sent: the account's owner sends `plan.calls` as a Safe MultiSend from
 * the Safe, or `plan.execute.data` to an ERC-7579 account (e.g. as a user operation).
 *
 * Returns the plan with the module's address (predicted by the factory) and the mandate JSON to
 * keep; `plan.params.mandateHash` is the on-chain commitment that ratings and quotes use. Then
 * use `new BondedVault({ vault: plan.module, ... })` from the agent's side.
 */
export async function installMandateModule(
  client: ContractReader,
  input: InstallMandateModuleInput,
): Promise<ModuleInstallPlan & { mandate: EvmMandate }> {
  const { mandate, params } = buildMandate(input.rules, { for: "module" });
  const plan = await prepareModuleInstall(client, {
    moduleFactory: input.moduleFactory,
    account: input.account,
    params,
    agent: input.agent,
    guardian: input.guardian,
    agentId: BigInt(input.rules.agentId),
    accountType: input.accountType,
  });
  return { ...plan, mandate };
}
