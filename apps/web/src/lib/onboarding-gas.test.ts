import { describe, expect, it, vi } from "vitest";
import { getContractAddress, type Address } from "viem";
import { deployment } from "../config";
import { buildMandate, MANDATE_TOKENS } from "./onboarding";
import { onboardingCall, simulateOnboardingGas, type SimClient } from "./onboarding-gas";

const USER = "0x00000000000000000000000000000000000000a1" as Address;
const form = {
  mode: "monitor" as const,
  tokens: [...MANDATE_TOKENS],
  destinations: [USER],
  maxTxUsd: 5000,
  maxDailyUsd: 25000,
  maxDrawdownPct: 15,
  maxSlippagePct: 3,
  description: "test",
};

describe("the onboarding's calls", () => {
  it("won't build a call before what it needs exists", () => {
    const ctx = { deployment, user: USER, agentKey: USER, bond: 1n, deposit: 1n, faucet: 2n };
    expect(onboardingCall("register", ctx).functionName).toBe("register");
    expect(() => onboardingCall("stake", ctx)).toThrow(/before the agent exists/);
    expect(() => onboardingCall("deposit", ctx)).toThrow(/before the vault exists/);
  });

  it("simulates them in order, with the next agent id and vault address", async () => {
    const simulateCalls = vi.fn(async (args: { calls: unknown[] }) => ({
      results: args.calls.map(() => ({ status: "success", gasUsed: 50_000n })),
    }));
    const client: SimClient = {
      readContract: async () => 41n,
      getTransactionCount: async () => 7,
      simulateCalls,
    };
    const mandateFor = vi.fn((id: bigint) => buildMandate(deployment, id, form));
    const used = await simulateOnboardingGas(client, {
      deployment,
      user: USER,
      agentKey: USER,
      bond: 4_000_000_000n,
      deposit: 50_000_000_000n,
      module: false,
      mandateFor,
    });
    expect(used).toHaveLength(7);
    expect(mandateFor).toHaveBeenCalledWith(42n);
    const calls = simulateCalls.mock.calls[0]![0].calls as { to: Address }[];
    // The deposit goes to the vault the factory's next deployment makes.
    expect(calls.at(-1)!.to).toBe(getContractAddress({ from: deployment.factory, nonce: 7n }));
  });

  it("gives no number when the RPC can't simulate or a call would fail", async () => {
    const base = { readContract: async () => 1n, getTransactionCount: async () => 1 };
    const input = {
      deployment,
      user: USER,
      agentKey: USER,
      bond: 0n,
      deposit: 0n,
      module: false,
      mandateFor: (id: bigint) => buildMandate(deployment, id, form),
    };
    expect(
      await simulateOnboardingGas(
        {
          ...base,
          simulateCalls: async () => Promise.reject(new Error("eth_simulateV1 not found")),
        },
        input,
      ),
    ).toBeUndefined();
    expect(
      await simulateOnboardingGas(
        { ...base, simulateCalls: async () => ({ results: [{ status: "failure" }] }) },
        input,
      ),
    ).toBeUndefined();
  });
});
