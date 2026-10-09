import { Sandbox, type SandboxRole } from "@bonded/sandbox";
import {
  bondedRegistryAbi,
  mandateVaultAbi,
  mandateVaultFactoryAbi,
  testTokenAbi,
} from "@bondedhq/shared";
import { type Abi, type Address, type Chain, parseUnits } from "viem";
import { buildMandate, type BuiltMandate, type EvmMandateRules } from "../src/index.js";
import { MULTICALL3_ADDRESS, MULTICALL3_RUNTIME } from "./fixtures/multicall3.js";

/**
 * Test chains for the SDK: a local anvil with the protocol deployed by the production scripts
 * (the Arena's sandbox), and vaults created through the real factory with mandates from the
 * SDK's own builder.
 */
export { Sandbox };

/** An attacker address: not a destination, spender or target in any test mandate. */
export const ATTACKER: Address = "0x000000000000000000000000000000000000dEaD";

/** Sends a contract write from a sandbox account and returns the simulated result. */
export async function send(
  sandbox: Sandbox,
  role: SandboxRole,
  call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
): Promise<unknown> {
  const wallet = sandbox.wallet(role);
  const { result, request } = await sandbox.publicClient.simulateContract({
    ...call,
    account: wallet.account,
  });
  const hash = await wallet.writeContract(request);
  const receipt = await sandbox.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${call.functionName} reverted (${hash})`);
  return result;
}

export interface TestVault extends BuiltMandate {
  address: Address;
  agentId: bigint;
}

/**
 * Registers an agent, creates its vault (agent key: the sandbox's `agent` account; guardian:
 * `operator`) with the demo market's tokens and router, and deposits 50,000 tUSDG.
 */
export async function createTestVault(
  sandbox: Sandbox,
  rules: Partial<EvmMandateRules> = {},
  agent: Address = sandbox.address("agent"),
): Promise<TestVault> {
  const d = sandbox.deployment;
  const agentId = (await send(sandbox, "operator", {
    address: d.registry,
    abi: bondedRegistryAbi,
    functionName: "register",
    args: ["ipfs://bonded/sdk-test/agent.json"],
  })) as bigint;
  const built = buildMandate({
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
    description: "SDK test vault: trade tTSLA and tNVDA against tUSDG.",
    ...rules,
  });
  const address = (await send(sandbox, "operator", {
    address: d.factory,
    abi: mandateVaultFactoryAbi,
    functionName: "createVault",
    args: [built.params, agent, sandbox.address("operator"), agentId, "SDK Test Vault", "sVAULT"],
  })) as Address;
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
    functionName: "approve",
    args: [address, amount],
  });
  await send(sandbox, "depositor", {
    address,
    abi: mandateVaultAbi,
    functionName: "deposit",
    args: [amount, sandbox.address("depositor")],
  });
  return { ...built, address, agentId };
}

/** The vault's balance of `token`. */
export function balanceOf(sandbox: Sandbox, token: Address, owner: Address): Promise<bigint> {
  return sandbox.publicClient.readContract({
    address: token,
    abi: testTokenAbi,
    functionName: "balanceOf",
    args: [owner],
  });
}

/** The vault's breach count, read straight from the contract. */
export function breachCount(sandbox: Sandbox, vault: Address): Promise<bigint> {
  return sandbox.publicClient.readContract({
    address: vault,
    abi: mandateVaultAbi,
    functionName: "breachCount",
  });
}

/**
 * Puts Multicall3 at its canonical address (AgentKit reads token details through it) and
 * returns the sandbox's chain with that address set, as on public chains.
 */
export async function withMulticall3(sandbox: Sandbox): Promise<Chain> {
  await sandbox.publicClient.request({
    method: "anvil_setCode" as never,
    params: [MULTICALL3_ADDRESS, MULTICALL3_RUNTIME] as never,
  });
  return { ...sandbox.chain, contracts: { multicall3: { address: MULTICALL3_ADDRESS } } };
}
