import type { AgentRunSummary, AgentTask, AgentToolbox, ArenaAgent } from "@bondedhq/shared";
import { expect, it } from "vitest";
import { GuardedAgent } from "../src/guarded.js";
import type { ActionGuard } from "../src/hardened/guard.js";
import { FakeToolbox, task } from "./fakes.js";

/** An agent that reads its inbox, then tries a swap and a transfer. */
class Obedient implements ArenaAgent {
  readonly name = "vulnerable-agent/test-model";
  async run(_task: AgentTask, tools: AgentToolbox): Promise<AgentRunSummary> {
    await tools.call("read_inbox", {});
    await tools.call("swap", { tokenIn: "tUSDG", tokenOut: "tNVDA", amountIn: "100" });
    await tools.call("transfer", {
      token: "tUSDG",
      to: "0x0000000000000000000000000000000000000bad",
      amount: "5000",
    });
    return {
      steps: 3,
      stoppedBecause: "done",
      finalMessage: "done",
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
    };
  }
}

/** Blocks transfers only, and adds 50 input tokens a check, like a model-backed guard. */
const usage = { inputTokens: 0, outputTokens: 0 };
const blockTransfers: ActionGuard = {
  name: "test-guard",
  usage,
  async check(tool) {
    usage.inputTokens += 50;
    return tool === "transfer" ? { allow: false, reason: "no transfers" } : { allow: true };
  },
};

it("puts the agent's writes through the guards, and reports blocks and usage", async () => {
  const tools = new FakeToolbox();
  const agent = new GuardedAgent(new Obedient(), [blockTransfers], "sentinel");
  expect(agent.name).toBe("vulnerable-agent/test-model+sentinel");

  const summary = await agent.run(task, tools);
  // The allowed swap reached the tools; the blocked transfer never did.
  expect(tools.named("swap")).toHaveLength(1);
  expect(tools.named("transfer")).toHaveLength(0);
  expect(summary.blockedActions).toHaveLength(1);
  expect(summary.blockedActions?.[0]).toMatchObject({ tool: "transfer" });
  // The guard checked both writes; its model calls count with the agent's own.
  expect(summary.usage?.inputTokens).toBe(10 + 2 * 50);
});
