import { decodeAbiParameters, decodeFunctionData, getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  ERC7579_BATCH_MODE,
  erc7579AccountAbi,
  hookInstallData,
  mandateCommitment,
  mandateModuleFactoryAbi,
  prepareModuleInstall,
  type EvmMandateParams,
} from "../src/index.js";

const factory: Address = "0x84eA74d481Ee0A5332c457a4d796187F6Ba67fEB";
const account: Address = getAddress("0x00000000000000000000000000000000000000aa");
const predicted: Address = getAddress("0x000000000000000000000000000000000000beef");
const agent: Address = getAddress("0x0000000000000000000000000000000000000a9e");
const guardian: Address = getAddress("0x0000000000000000000000000000000000000ca7");
const params: EvmMandateParams = {
  mandateHash: `0x${"12".repeat(32)}`, // a JSON hash; the helper replaces it
  mode: 1,
  baseAsset: "0x1111111111111111111111111111111111111111",
  assets: ["0x1111111111111111111111111111111111111111"],
  targets: ["0x3333333333333333333333333333333333333333"],
  selectors: [[]],
  destinations: [],
  maxTxNotionalUsd6: 5_000_000_000n,
  maxDailyNotionalUsd6: 25_000_000_000n,
  maxDrawdownBps: 1500,
  maxSlippageBps: 300,
  freezeOnBreach: true,
};

/** A client whose only read is predictModule; records what it was asked. */
function fakeClient() {
  const asked: unknown[] = [];
  return {
    asked,
    client: {
      readContract: (async (request: { functionName: string; args: unknown[] }) => {
        asked.push(request);
        if (request.functionName !== "predictModule") throw new Error("unexpected read");
        return predicted;
      }) as never,
    },
  };
}

describe("prepareModuleInstall", () => {
  it("predicts the module, then creates it and installs it as executor and hook", async () => {
    const { client, asked } = fakeClient();
    const plan = await prepareModuleInstall(client, {
      moduleFactory: factory,
      account,
      params,
      agent,
      guardian,
      agentId: 7n,
      accountType: "safe7579",
    });
    const commitment = mandateCommitment(params);
    expect(plan.module).toBe(predicted);
    expect(plan.params.mandateHash).toBe(commitment);
    // predictModule is asked with the committed params, so the address matches what's created.
    const predictArgs = (asked[0] as { args: [Address, EvmMandateParams] }).args;
    expect(predictArgs[0]).toBe(account);
    expect(predictArgs[1].mandateHash).toBe(commitment);

    const [create, executor, hook] = plan.calls;
    expect(create.to).toBe(factory);
    const created = decodeFunctionData({ abi: mandateModuleFactoryAbi, data: create.data });
    expect(created.functionName).toBe("createModule");
    expect(created.args).toEqual([{ ...params, mandateHash: commitment }, agent, guardian, 7n]);

    expect(executor.to).toBe(account);
    expect(decodeFunctionData({ abi: erc7579AccountAbi, data: executor.data }).args).toEqual([
      2n,
      predicted,
      "0x",
    ]);
    expect(hook.to).toBe(account);
    expect(decodeFunctionData({ abi: erc7579AccountAbi, data: hook.data }).args).toEqual([
      4n,
      predicted,
      hookInstallData("safe7579"),
    ]);
    expect(plan.calls.every((c) => c.value === 0n)).toBe(true);
  });

  it("encodes the same calls as one ERC-7579 batch", async () => {
    const plan = await prepareModuleInstall(fakeClient().client, {
      moduleFactory: factory,
      account,
      params,
      agent,
      guardian,
      agentId: 7n,
      accountType: "erc7579",
    });
    const call = decodeFunctionData({ abi: erc7579AccountAbi, data: plan.execute.data });
    expect(call.functionName).toBe("execute");
    expect(call.args?.[0]).toBe(ERC7579_BATCH_MODE);
    const [executions] = decodeAbiParameters(
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
      plan.execute.executionCalldata,
    );
    expect(executions.map((e) => [e.target, e.value, e.callData])).toEqual(
      plan.calls.map((c) => [c.to, c.value, c.data]),
    );
    // The reference account takes the hook's own init data.
    expect(decodeFunctionData({ abi: erc7579AccountAbi, data: plan.calls[2].data }).args?.[2]).toBe(
      "0x",
    );
  });
});

describe("hookInstallData", () => {
  it("wraps the hook for Safe7579 as a global hook", () => {
    expect(hookInstallData("safe7579")).toBe(
      // HookType.GLOBAL (0), bytes4(0), empty bytes
      `0x${"00".repeat(32)}${"00".repeat(32)}${"00".repeat(31)}60${"00".repeat(32)}`,
    );
    expect(hookInstallData("erc7579")).toBe("0x");
  });
});
