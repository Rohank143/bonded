import {
  bondedRegistryAbi,
  mandateVaultAbi,
  mandateVaultFactoryAbi,
  operatorBondAbi,
  testTokenAbi,
  toEvmMandateParams,
  type EvmDeployment,
  type EvmMandate,
} from "@bondedhq/shared";
import { encodeFunctionData, getContractAddress, type Abi, type Address, type Hex } from "viem";
import type { OnboardingCall } from "./wallet-help";

/** What the onboarding's calls need: some of it exists only once earlier calls have run. */
export interface CallContext {
  deployment: EvmDeployment;
  user: Address;
  agentKey: Address;
  bond: bigint;
  deposit: bigint;
  /** The test tUSDG the faucet mints: the bond not yet staked plus the deposit. */
  faucet: bigint;
  agentId?: bigint;
  mandate?: EvmMandate;
  vault?: Address;
}

export interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

/** One onboarding transaction, ready to send. Throws when what it needs doesn't exist yet. */
export function onboardingCall(
  kind: Exclude<OnboardingCall, "findModule">,
  c: CallContext,
): ContractCall {
  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`can't ${kind} before ${what} exists`);
    return v;
  };
  const d = c.deployment;
  switch (kind) {
    case "register":
      return {
        address: d.registry,
        abi: bondedRegistryAbi as Abi,
        functionName: "register",
        args: ["ipfs://bonded/self-serve"],
      };
    case "faucet":
      return {
        address: d.usdg,
        abi: testTokenAbi as Abi,
        functionName: "faucet",
        args: [c.faucet],
      };
    case "approveBond":
      return {
        address: d.usdg,
        abi: testTokenAbi as Abi,
        functionName: "approve",
        args: [d.bond, c.bond],
      };
    case "stake":
      return {
        address: d.bond,
        abi: operatorBondAbi as Abi,
        functionName: "stake",
        args: [need(c.agentId, "the agent"), c.bond],
      };
    case "createVault": {
      const agentId = need(c.agentId, "the agent");
      return {
        address: d.factory,
        abi: mandateVaultFactoryAbi as Abi,
        functionName: "createVault",
        args: [
          toEvmMandateParams(need(c.mandate, "the mandate")),
          c.agentKey,
          c.user,
          agentId,
          `Agent ${agentId} vault`,
          "BVLT",
        ],
      };
    }
    case "approveDeposit":
      return {
        address: d.usdg,
        abi: testTokenAbi as Abi,
        functionName: "approve",
        args: [need(c.vault, "the vault"), c.deposit],
      };
    case "deposit":
      return {
        address: need(c.vault, "the vault"),
        abi: mandateVaultAbi as Abi,
        functionName: "deposit",
        args: [c.deposit, c.user],
      };
  }
}

/** The call as EIP-5792 `wallet_sendCalls` takes it. */
export const encoded = (call: ContractCall): { to: Address; data: Hex } => ({
  to: call.address,
  data: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args }),
});

/** The parts of a public client the simulation uses. */
export interface SimClient {
  readContract: (args: { address: Address; abi: Abi; functionName: string }) => Promise<unknown>;
  getTransactionCount: (args: { address: Address }) => Promise<number>;
  simulateCalls: (args: {
    account: Address;
    calls: { to: Address; data: Hex }[];
  }) => Promise<{ results: { status: string; gasUsed?: bigint }[] }>;
}

/**
 * The gas each onboarding transaction would use, simulated in order on the current chain state
 * (`eth_simulateV1`). The next agent id and the vault's address are predicted for the simulation
 * only: they are exact there, and the real transactions read them from their receipts. Undefined
 * when the RPC can't simulate, or any call would fail.
 */
export async function simulateOnboardingGas(
  client: SimClient,
  input: {
    deployment: EvmDeployment;
    user: Address;
    agentKey: Address;
    bond: bigint;
    deposit: bigint;
    module: boolean;
    /** Builds the mandate for an agent id (as onboarding does right after registering). */
    mandateFor: (agentId: bigint) => EvmMandate;
  },
): Promise<bigint[] | undefined> {
  try {
    const d = input.deployment;
    const total = (await client.readContract({
      address: d.registry,
      abi: bondedRegistryAbi as Abi,
      functionName: "totalAgents",
    })) as bigint;
    const agentId = total + 1n;
    const deposit = input.module ? 0n : input.deposit;
    const vault = input.module
      ? undefined
      : getContractAddress({
          from: d.factory,
          nonce: BigInt(await client.getTransactionCount({ address: d.factory })),
        });
    const ctx: CallContext = {
      deployment: d,
      user: input.user,
      agentKey: input.agentKey,
      bond: input.bond,
      deposit,
      faucet: input.bond + deposit,
      agentId,
      mandate: input.mandateFor(agentId),
      ...(vault ? { vault } : {}),
    };
    const kinds: Exclude<OnboardingCall, "findModule">[] = [
      "register",
      ...(ctx.faucet > 0n ? (["faucet"] as const) : []),
      ...(input.bond > 0n ? (["approveBond", "stake"] as const) : []),
      ...(input.module ? [] : (["createVault"] as const)),
      ...(deposit > 0n ? (["approveDeposit", "deposit"] as const) : []),
    ];
    const { results } = await client.simulateCalls({
      account: input.user,
      calls: kinds.map((k) => encoded(onboardingCall(k, ctx))),
    });
    if (results.some((r) => r.status !== "success" || r.gasUsed === undefined)) return undefined;
    return results.map((r) => r.gasUsed!);
  } catch {
    return undefined;
  }
}
