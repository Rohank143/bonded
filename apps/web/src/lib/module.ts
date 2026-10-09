import type { ModuleAccountType, ModuleInstallPlan } from "@bondedhq/shared";
import type { Address, Hex } from "viem";

/**
 * Protecting the smart account an agent already uses (ERC-7579, e.g. Safe through Safe7579) with
 * a MandateModule instead of a Bonded vault. The account itself makes the calls (create the
 * module, install it as an executor and as a hook); `prepareModuleInstall` in @bondedhq/shared
 * builds them, and this turns its plan into what the owner sends from their account.
 */

/** One transaction (or batch entry) for the owner to send from the smart account. */
export interface ModuleCall {
  label: string;
  to: Address;
  data: Hex;
}

/** Account types the onboarding page offers, in plain words. */
export const ACCOUNT_TYPE_LABELS: Record<ModuleAccountType, string> = {
  safe7579: "Safe (with the Safe7579 adapter)",
  erc7579: "Another ERC-7579 account",
};

/**
 * What to send: for a Safe, the three calls as one MultiSend batch (the transaction builder takes
 * them as they are); for another ERC-7579 account, one `execute` call carrying the same batch.
 */
export function installSteps(
  plan: ModuleInstallPlan,
  accountType: ModuleAccountType,
): ModuleCall[] {
  if (accountType === "erc7579")
    return [
      {
        label: "One call to your account: execute the batch (create, install as executor and hook)",
        to: plan.calls[1].to,
        data: plan.execute.data,
      },
    ];
  const labels = [
    "Create the module",
    "Install it as an executor",
    "Install it as a hook (a global hook)",
  ];
  return plan.calls.map((call, i) => ({ label: labels[i]!, to: call.to, data: call.data }));
}

/**
 * What cover on a module means, in plain words. A module holds cover only in Enforce mode, so a
 * breach is blocked rather than paid; a loss it only finds later (a deferred breach) is recorded
 * but not paid, since it can't be told apart from the account's owner moving funds; and any other
 * payout needs a dispute the council approves.
 */
export const MODULE_COVER_NOTE =
  "On a smart account the module must run in Enforce mode: a breach it catches is blocked, so there is no loss to pay. A loss it only finds later (a deferred breach) is recorded but not paid, because it can't be told apart from the account's owner moving funds. Any other payout on a module needs a dispute the council approves.";
