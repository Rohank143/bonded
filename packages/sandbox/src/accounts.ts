import { readFileSync } from "node:fs";
import {
  type Abi,
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  type Hex,
  parseEventLogs,
  zeroAddress,
} from "viem";
import { CONTRACTS_DIR, type Sandbox } from "./sandbox.js";

/**
 * Real ERC-7579 smart accounts on a sandbox chain, for MandateModule tests, deployed from the
 * Foundry build (contracts/evm/out) the way the contracts' own module tests set them up
 * (contracts/evm/test/module/ModuleTestBase.sol): the ERC-7579 reference account (MSAAdvanced
 * behind a proxy) and a Safe 1.4.1 with the Safe7579 adapter. Neither has a validator, so the
 * owner acts as the EntryPoint would after validating an operation: send from `ENTRY_POINT`
 * with `asEntryPoint`.
 */

/** The ERC-4337 EntryPoint v0.7: accounts accept the owner's operations from it. */
export const ENTRY_POINT: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

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

/** A new ERC-7579 reference account (MSAAdvanced), with no modules. */
export async function deployReferenceAccount(sandbox: Sandbox): Promise<Address> {
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
export async function deploySafe7579Account(sandbox: Sandbox): Promise<Address> {
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
    const hash = await wallet.writeContract({
      address: safe,
      abi: singleton.abi,
      functionName: "execTransaction",
      args: [safe, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signature],
    });
    const result = await sandbox.publicClient.waitForTransactionReceipt({ hash });
    if (result.status !== "success") throw new Error("the Safe owner's transaction failed");
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

/** Sends `data` to `account` from the EntryPoint (impersonated), as a validated user operation would. */
export async function asEntryPoint(sandbox: Sandbox, account: Address, data: Hex): Promise<void> {
  const entryPoint = await sandbox.impersonate(ENTRY_POINT);
  const hash = await entryPoint.sendTransaction({ to: account, data });
  const receipt = await sandbox.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`the account's operation failed (${hash})`);
}
