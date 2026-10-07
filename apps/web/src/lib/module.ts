import {
  mandateModuleFactoryAbi,
  toEvmMandateParams,
  withMandateCommitment,
  type EvmMandate,
} from "@bonded/shared";
import { encodeAbiParameters, encodeFunctionData, type Address, type Hex } from "viem";

/**
 * Protecting the smart account an agent already uses (ERC-7579, e.g. Safe through Safe7579) with
 * a MandateModule instead of a Bonded vault. The account itself must make the calls: create the
 * module, then install it as an executor (the agent acts through it) and as a hook (it sees every
 * other execution). Until the shared one-batch helper lands, this builds the three calls for the
 * owner to send from their account.
 */

/** ERC-7579 module types. */
export const MODULE_TYPE = { executor: 2n, hook: 4n } as const;

const installModuleAbi = [
  {
    type: "function",
    name: "installModule",
    stateMutability: "payable",
    inputs: [
      { name: "moduleTypeId", type: "uint256" },
      { name: "module", type: "address" },
      { name: "initData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export interface ModuleCall {
  label: string;
  to: Address;
  data: Hex;
}

/**
 * The calls the smart account sends, in order. `predicted` is the module's address
 * (`MandateModuleFactory.predictModule`, read before the first call). The hook's install data is
 * Safe7579's (a global hook); other ERC-7579 accounts may want their own.
 */
export function moduleInstallCalls(input: {
  factory: Address;
  account: Address;
  mandate: EvmMandate;
  agentKey: Address;
  guardian: Address;
  agentId: bigint;
  predicted: Address;
}): ModuleCall[] {
  const params = withMandateCommitment(toEvmMandateParams(input.mandate));
  return [
    {
      label: "Create the module (from the smart account)",
      to: input.factory,
      data: encodeFunctionData({
        abi: mandateModuleFactoryAbi,
        functionName: "createModule",
        args: [params, input.agentKey, input.guardian, input.agentId],
      }),
    },
    {
      label: "Install it as an executor",
      to: input.account,
      data: encodeFunctionData({
        abi: installModuleAbi,
        functionName: "installModule",
        args: [MODULE_TYPE.executor, input.predicted, "0x"],
      }),
    },
    {
      label: "Install it as a hook (Safe7579: a global hook)",
      to: input.account,
      data: encodeFunctionData({
        abi: installModuleAbi,
        functionName: "installModule",
        args: [
          MODULE_TYPE.hook,
          input.predicted,
          encodeAbiParameters(
            [{ type: "uint8" }, { type: "bytes4" }, { type: "bytes" }],
            [0, "0x00000000", "0x"],
          ),
        ],
      }),
    },
  ];
}

/** What cover on a module doesn't pay, in plain words. */
export const MODULE_DEFERRED_NOTE =
  "On a smart account, a loss the module only finds later (a deferred breach) is recorded but not paid: it can't be told apart from the account's owner moving funds. Breaches it catches as they happen are covered as usual.";
