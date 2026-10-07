import { readFileSync } from "node:fs";
import { CONTRACTS_DIR, type Sandbox } from "@bonded/sandbox";
import { bondedRegistryAbi, mandateModuleFactoryAbi, testTokenAbi } from "@bonded/shared";
import {
  type Abi,
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  type Hex,
  parseEventLogs,
  parseUnits,
  zeroAddress,
} from "viem";
import { buildMandate, type BuiltMandate, type EvmMandateRules } from "../src/index.js";
import { send } from "./chain.js";

/**
 * Real ERC-7579 accounts on the sandbox chain, deployed from the Foundry build the way the
 * contracts' own module tests set them up (contracts/evm/test/module/ModuleTestBase.sol): the
 * ERC-7579 reference account (MSAAdvanced behind a proxy) and a Safe 1.4.1 with the Safe7579
 * adapter. The account's owner acts as the EntryPoint would, by impersonating it.
 */

const ENTRY_POINT: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const EXECUTOR = 2n;
const HOOK = 4n;

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(`${CONTRACTS_DIR}out/${file}/${name}.json`, "utf8")) as {
    abi: Abi;
    bytecode: { object: Hex };
  };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

async function deploy(sandbox: Sandbox, file: string, name: string, args: unknown[] = []) {
  const { abi, bytecode } = artifact(file, name);
  const wallet = sandbox.wallet("deployer");
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const receipt = await sandbox.publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`deploying ${name} failed`);
  return { address: getAddress(receipt.contractAddress), abi };
}

export type AccountKind = "msa" | "safe";

/** A new ERC-7579 reference account (MSAAdvanced), with no modules. */
export async function newMsaAccount(sandbox: Sandbox): Promise<Address> {
  const msa = await deploy(sandbox, "MSAAdvanced.sol", "MSAAdvanced");
  const bootstrap = await deploy(sandbox, "Bootstrap.sol", "Bootstrap");
  const none: { module: Address; data: Hex }[] = [];
  const init = encodeAbiParameters(
    [{ type: "address" }, { type: "bytes" }],
    [
      bootstrap.address,
      encodeFunctionData({
        abi: bootstrap.abi,
        functionName: "initMSA",
        args: [none, none, { module: zeroAddress, data: "0x" }, none],
      }),
    ],
  );
  const proxy = await deploy(sandbox, "ModuleTestBase.sol", "TestMSAProxy", [
    msa.address,
    encodeFunctionData({ abi: msa.abi, functionName: "initializeAccount", args: [init] }),
  ]);
  return proxy.address;
}

/** A new 1-of-1 Safe (owner: the sandbox's operator) turned into an ERC-7579 account by Safe7579. */
export async function newSafeAccount(sandbox: Sandbox): Promise<Address> {
  const singleton = await deploy(sandbox, "Safe.sol", "Safe");
  const factory = await deploy(sandbox, "SafeProxyFactory.sol", "SafeProxyFactory");
  const adapter = await deploy(sandbox, "Safe7579.sol", "Safe7579");
  const owner = sandbox.address("operator");
  const setup = encodeFunctionData({
    abi: singleton.abi,
    functionName: "setup",
    args: [[owner], 1n, zeroAddress, "0x", adapter.address, zeroAddress, 0n, zeroAddress],
  });
  const wallet = sandbox.wallet("operator");
  const hash = await wallet.writeContract({
    address: factory.address,
    abi: factory.abi,
    functionName: "createProxyWithNonce",
    args: [singleton.address, setup, 1n],
  });
  const receipt = await sandbox.publicClient.waitForTransactionReceipt({ hash });
  const created = parseEventLogs({
    abi: factory.abi,
    logs: receipt.logs,
    eventName: "ProxyCreation",
  });
  const safe = (created[0]!.args as { proxy: Address }).proxy;

  // The owner's own Safe transactions (signature type 1: approved by being the sender).
  const ownerCall = async (data: Hex) => {
    const signature = encodePacked(
      ["uint256", "bytes32", "uint8"],
      [BigInt(owner), `0x${"00".repeat(32)}`, 1],
    );
    await send(sandbox, "operator", {
      address: safe,
      abi: singleton.abi,
      functionName: "execTransaction",
      args: [safe, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signature],
    });
  };
  await ownerCall(
    encodeFunctionData({
      abi: singleton.abi,
      functionName: "enableModule",
      args: [adapter.address],
    }),
  );
  await ownerCall(
    encodeFunctionData({
      abi: adapter.abi,
      functionName: "initializeAccount",
      args: [[], [], [], [], { registry: zeroAddress, attesters: [], threshold: 0 }],
    }),
  );
  return safe;
}

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
  rules: Partial<EvmMandateRules> = {},
  options: { install?: boolean } = {},
): Promise<ProtectedAccount> {
  const d = sandbox.deployment;
  if (!d.moduleFactory) throw new Error("this deployment has no MandateModuleFactory");
  const account = kind === "msa" ? await newMsaAccount(sandbox) : await newSafeAccount(sandbox);
  const agentId = (await send(sandbox, "operator", {
    address: d.registry,
    abi: bondedRegistryAbi,
    functionName: "register",
    args: ["ipfs://bonded/sdk-test/module-agent.json"],
  })) as bigint;
  const built = buildMandate(
    {
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
      ...rules,
    },
    { for: "module" },
  );

  // The account creates its own module (the factory binds the module to msg.sender).
  const asAccount = await sandbox.impersonate(account);
  const createHash = await asAccount.writeContract({
    address: d.moduleFactory,
    abi: mandateModuleFactoryAbi,
    functionName: "createModule",
    args: [built.params, sandbox.address("agent"), sandbox.address("operator"), agentId],
  });
  const created = parseEventLogs({
    abi: mandateModuleFactoryAbi,
    logs: (await sandbox.publicClient.waitForTransactionReceipt({ hash: createHash })).logs,
    eventName: "ModuleCreated",
  });
  const module = created[0]!.args.module;

  // The owner installs it, as the EntryPoint would after validating the owner's operation.
  const entryPoint = await sandbox.impersonate(ENTRY_POINT);
  const installAbi = artifact("MSAAdvanced.sol", "MSAAdvanced").abi;
  for (const type of options.install === false ? [] : [EXECUTOR, HOOK]) {
    const data =
      type === HOOK && kind === "safe"
        ? encodeAbiParameters(
            [{ type: "uint8" }, { type: "bytes4" }, { type: "bytes" }],
            [0, "0x00000000", "0x"],
          )
        : "0x";
    const hash = await entryPoint.writeContract({
      address: account,
      abi: installAbi,
      functionName: "installModule",
      args: [type, module, data],
    });
    const receipt = await sandbox.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success")
      throw new Error(`installing the module (type ${type}) failed`);
  }

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
