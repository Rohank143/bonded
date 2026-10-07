import {
  type AgentRunSummary,
  type AgentTask,
  type AgentToolbox,
  demoRouterAbi,
  mandateVaultAbi,
  testTokenAbi,
} from "@bonded/shared";
import { createWalletClient, encodeFunctionData, http, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ArenaToolbox,
  createAgentVault,
  loadAttackLibrary,
  marketTokens,
  runEpisode,
  Sandbox,
  type SelfSigningAgent,
  World,
} from "../src/index.js";

let sandbox: Sandbox;

beforeAll(async () => {
  sandbox = await Sandbox.start();
});
afterAll(async () => {
  await sandbox?.stop();
});

/** A vault whose agent is a fresh key, and a function that signs execute() with that key. */
async function ownKeyVault(mode: "monitor" | "enforce" = "monitor") {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  await sandbox.fund(account.address);
  const vault = await createAgentVault(sandbox, { agent: account.address, mandate: { mode } });
  const wallet = createWalletClient({
    account,
    chain: sandbox.chain,
    transport: http(sandbox.rpcUrl),
  });
  const execute = (target: `0x${string}`, data: `0x${string}`) =>
    wallet.writeContract({
      address: vault.address,
      abi: mandateVaultAbi,
      functionName: "execute",
      args: [target, data],
      gas: 1_000_000n,
    });
  return { account, vault, execute };
}

const tokens = () => marketTokens(sandbox);
const usdg = () => tokens()[0]!.address;
const transferData = (to: `0x${string}`, amount: number) =>
  encodeFunctionData({
    abi: testTokenAbi,
    functionName: "transfer",
    args: [to, parseUnits(String(amount), 6)],
  });

describe("transactions an agent signs itself", () => {
  it("creates the vault with the agent's own key, which the sandbox key can't use", async () => {
    const { account, vault } = await ownKeyVault();
    const agent = await sandbox.publicClient.readContract({
      address: vault.address,
      abi: mandateVaultAbi,
      functionName: "agent",
    });
    expect(agent).toBe(account.address);
    const world = new World(tokens(), sandbox.address("depositor"));
    const toolbox = new ArenaToolbox(sandbox, world, vault.address, 5);
    const result = await toolbox.call("swap", {
      tokenIn: "tUSDG",
      tokenOut: "tNVDA",
      amountIn: "100",
    });
    expect(result).toEqual({ ok: false, error: "reverted: NotAgent" });
  });

  it("records each transaction as a step, with its hash and the breaches it caused", async () => {
    const { vault, execute } = await ownKeyVault();
    const world = new World(tokens(), sandbox.address("depositor"));
    const toolbox = new ArenaToolbox(sandbox, world, vault.address, 10);
    const approve = await toolbox.recordTransaction({ step: "approve" }, () =>
      execute(
        usdg(),
        encodeFunctionData({
          abi: testTokenAbi,
          functionName: "approve",
          args: [sandbox.deployment.router, parseUnits("1000", 6)],
        }),
      ),
    );
    expect(approve.ok).toBe(true);
    const swap = await toolbox.recordTransaction({ step: "swap" }, () =>
      execute(
        sandbox.deployment.router,
        encodeFunctionData({
          abi: demoRouterAbi,
          functionName: "swap",
          args: [usdg(), sandbox.deployment.nvda, parseUnits("1000", 6), vault.address],
        }),
      ),
    );
    expect(swap.ok).toBe(true);
    const attacker = privateKeyToAccount(generatePrivateKey()).address;
    // Monitor mode: the theft goes through and is recorded.
    const theft = await toolbox.recordTransaction({ step: "theft" }, () =>
      execute(usdg(), transferData(attacker, 500)),
    );
    expect(theft.ok).toBe(true);
    expect(toolbox.trace.map((s) => [s.tool, s.breaches.length, s.txHashes.length])).toEqual([
      ["execute", 0, 1],
      ["execute", 0, 1],
      ["execute", 1, 1],
    ]);
  });

  it("fails the step when Enforce mode blocks the action, as a write tool would", async () => {
    const { vault, execute } = await ownKeyVault("enforce");
    const toolbox = new ArenaToolbox(
      sandbox,
      new World(tokens(), sandbox.address("depositor")),
      vault.address,
      10,
    );
    const attacker = privateKeyToAccount(generatePrivateKey()).address;
    const result = await toolbox.recordTransaction({}, () =>
      execute(usdg(), transferData(attacker, 500)),
    );
    expect(result).toEqual({ ok: false, error: "blocked by the vault (T1_UNAUTHORIZED_TRANSFER)" });
    expect(toolbox.trace[0]?.breaches).toEqual([0]);
  });

  it("holds the step cap and refuses transactions once the episode is over, without sending", async () => {
    const { vault, execute } = await ownKeyVault();
    const toolbox = new ArenaToolbox(
      sandbox,
      new World(tokens(), sandbox.address("depositor")),
      vault.address,
      1,
    );
    await toolbox.call("get_prices", {});
    let sent = 0;
    const send = () => {
      sent++;
      return execute(usdg(), transferData(sandbox.address("depositor"), 1));
    };
    expect(await toolbox.recordTransaction({}, send)).toEqual({
      ok: false,
      error: "step limit of 1 reached",
    });
    await toolbox.close();
    expect(await toolbox.recordTransaction({}, send)).toEqual({
      ok: false,
      error: "the episode is over",
    });
    expect(sent).toBe(0);
  });

  it("runs an episode whose vault names the agent's own key, judged from the same breach log", async () => {
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    const spec = loadAttackLibrary().find((s) => s.id === "A6-operator-impersonation-001")!;
    class Thief implements SelfSigningAgent {
      readonly name = "own-key-thief";
      async episodeSigner(s: Sandbox) {
        await s.fund(account.address);
        return account.address;
      }
      async run(task: AgentTask, tools: AgentToolbox): Promise<AgentRunSummary> {
        const box = tools as ArenaToolbox;
        const wallet = createWalletClient({
          account,
          chain: sandbox.chain,
          transport: http(sandbox.rpcUrl),
        });
        const attacker = privateKeyToAccount(generatePrivateKey()).address;
        await box.recordTransaction({}, () =>
          wallet.writeContract({
            address: box.vault,
            abi: mandateVaultAbi,
            functionName: "execute",
            args: [usdg(), transferData(attacker, 1000)],
            gas: 1_000_000n,
          }),
        );
        return { steps: box.trace.length, stoppedBecause: "done" };
      }
    }
    const result = await runEpisode(sandbox, { agent: new Thief(), attack: spec });
    expect(result.verdict.breached).toBe(true);
    expect(result.verdict.breaches[0]?.type).toBe("T1_UNAUTHORIZED_TRANSFER");
    expect(result.trace[0]?.tool).toBe("execute");
  });
});
