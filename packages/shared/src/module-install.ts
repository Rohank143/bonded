import { encodeAbiParameters, encodeFunctionData, type Address, type Hex } from "viem";
import { mandateModuleFactoryAbi } from "./abis.js";
import type { EvmMandateParams } from "./schemas/mandate.js";
import { withMandateCommitment } from "./schemas/mandate-commitment.js";

/**
 * The ERC-7579 account functions used to install a MandateModule and to batch calls.
 * `mode` is the ERC-7579 ModeCode (bytes32).
 */
export const erc7579AccountAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "mode", type: "bytes32" },
      { name: "executionCalldata", type: "bytes" },
    ],
    outputs: [],
  },
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
  {
    type: "function",
    name: "uninstallModule",
    stateMutability: "payable",
    inputs: [
      { name: "moduleTypeId", type: "uint256" },
      { name: "module", type: "address" },
      { name: "deInitData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "isModuleInstalled",
    stateMutability: "view",
    inputs: [
      { name: "moduleTypeId", type: "uint256" },
      { name: "module", type: "address" },
      { name: "additionalContext", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** ERC-7579 module types MandateModule is installed as. */
export const MODULE_TYPE_EXECUTOR = 2n;
export const MODULE_TYPE_HOOK = 4n;

/** ERC-7579 mode for a batch of calls that reverts if any fails (call type 0x01). */
export const ERC7579_BATCH_MODE: Hex = `0x01${"00".repeat(31)}`;

/**
 * - `safe7579`: a Safe with the Safe7579 adapter. Its hook install data is
 *   `abi.encode(HookType.GLOBAL, bytes4(0), bytes(""))`.
 * - `erc7579`: an account following the ERC-7579 reference implementation, whose hook install
 *   data is the module's own init data (empty here). Other accounts may differ (Kernel, for
 *   example, has its own formats); check before using this for them.
 */
export type ModuleAccountType = "safe7579" | "erc7579";

/**
 * Anything that can read a contract, such as a viem PublicClient. Kept structural so clients
 * from another copy of viem fit too.
 */
export interface ContractReader {
  readContract(request: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
}

/** One call the account makes, in the shape Safe MultiSend and ERC-7579 batches both take. */
export interface ModuleInstallCall {
  to: Address;
  value: bigint;
  data: Hex;
}

export interface ModuleInstallInput {
  /** MandateModuleFactory (`moduleFactory` in the deployment file). */
  moduleFactory: Address;
  /** The smart account to protect. It makes the calls, so it is the module's account. */
  account: Address;
  /** Mandate params; `mandateHash` is replaced by their commitment, as the factory requires. */
  params: EvmMandateParams;
  /** The agent's session key. */
  agent: Address;
  /** Can freeze, unfreeze and rotate the agent; must own `agentId` to buy cover. */
  guardian: Address;
  agentId: bigint;
  accountType: ModuleAccountType;
}

export interface ModuleInstallPlan {
  /** Where the module will be deployed (MandateModuleFactory.predictModule). */
  module: Address;
  /** The params actually sent: `mandateHash` is the on-chain commitment (also the hash to rate and quote). */
  params: EvmMandateParams;
  /** createModule, then installModule as executor (type 2) and as hook (type 4). */
  calls: [ModuleInstallCall, ModuleInstallCall, ModuleInstallCall];
  /** The same three calls as one ERC-7579 batch: `account.execute(mode, executionCalldata)`. */
  execute: { mode: Hex; executionCalldata: Hex; data: Hex };
}

/** Init data for installing MandateModule as a hook on `accountType`. */
export function hookInstallData(accountType: ModuleAccountType): Hex {
  if (accountType === "erc7579") return "0x";
  // Safe7579: abi.encode(HookType.GLOBAL (0), bytes4(0), bytes(""))
  return encodeAbiParameters(
    [{ type: "uint8" }, { type: "bytes4" }, { type: "bytes" }],
    [0, "0x00000000", "0x"],
  );
}

/** The three calls, for a module address already known (see `prepareModuleInstall`). */
export function moduleInstallCalls(
  input: ModuleInstallInput & { module: Address },
): ModuleInstallPlan["calls"] {
  const params = withMandateCommitment(input.params);
  const install = (moduleType: bigint, initData: Hex): ModuleInstallCall => ({
    to: input.account,
    value: 0n,
    data: encodeFunctionData({
      abi: erc7579AccountAbi,
      functionName: "installModule",
      args: [moduleType, input.module, initData],
    }),
  });
  return [
    {
      to: input.moduleFactory,
      value: 0n,
      data: encodeFunctionData({
        abi: mandateModuleFactoryAbi,
        functionName: "createModule",
        args: [params, input.agent, input.guardian, input.agentId],
      }),
    },
    install(MODULE_TYPE_EXECUTOR, "0x"),
    install(MODULE_TYPE_HOOK, hookInstallData(input.accountType)),
  ];
}

/** Calls as an ERC-7579 batch for `account.execute`. */
export function erc7579Batch(calls: readonly ModuleInstallCall[]): ModuleInstallPlan["execute"] {
  const executionCalldata = encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    [calls.map((c) => ({ target: c.to, value: c.value, callData: c.data }))],
  );
  return {
    mode: ERC7579_BATCH_MODE,
    executionCalldata,
    data: encodeFunctionData({
      abi: erc7579AccountAbi,
      functionName: "execute",
      args: [ERC7579_BATCH_MODE, executionCalldata],
    }),
  };
}

/**
 * Everything an account needs to create and install its MandateModule in one transaction:
 * reads the module's future address from the factory, then builds createModule followed by
 * installModule as executor and as hook. Send `calls` as a Safe MultiSend from the Safe, or
 * `execute.data` to an ERC-7579 account (for example as a user operation's call data).
 *
 * The predicted address assumes nothing changes in between: the account creates no other
 * module first and the vault factory's oracle stays the same.
 */
export async function prepareModuleInstall(
  client: ContractReader,
  input: ModuleInstallInput,
): Promise<ModuleInstallPlan> {
  const params = withMandateCommitment(input.params);
  const module = (await client.readContract({
    address: input.moduleFactory,
    abi: mandateModuleFactoryAbi,
    functionName: "predictModule",
    args: [input.account, params, input.agent, input.guardian, input.agentId],
  })) as Address;
  const calls = moduleInstallCalls({ ...input, params, module });
  return { module, params, calls, execute: erc7579Batch(calls) };
}
