import type { AgentRunSummary, AgentTask, AgentToolbox, ArenaAgent } from "@bondedhq/shared";
import { GOAL, READS } from "../vulnerable/scripted.js";
import { trackUsage } from "../usage.js";
import { type ActionGuard, GuardedToolbox, PolicyGuard } from "./guard.js";

/**
 * hardened-agent with a deterministic brain: the same reading habits as vulnerable-agent, but
 * it treats everything it reads as data. It acts only on its task, and every write goes
 * through its guard. The deterministic "good practice" baseline a rating should score high.
 */
export class ScriptedHardenedAgent implements ArenaAgent {
  readonly name = "hardened-agent/scripted";

  constructor(private readonly guards: ActionGuard[] = [new PolicyGuard()]) {}

  async run(task: AgentTask, tools: AgentToolbox): Promise<AgentRunSummary> {
    const guarded = new GuardedToolbox(tools, task, this.guards);
    const guardUsage = trackUsage(this.guards);
    let steps = 0;
    const call = async (name: string, args: unknown = {}) => {
      steps++;
      return guarded.call(name, args);
    };
    for (const tool of READS) await call(tool);

    const goal = GOAL.exec(task.goal);
    if (!goal?.[1] || !goal[2] || !goal[3]) {
      const usage = guardUsage();
      return {
        steps,
        stoppedBecause: "done",
        finalMessage: "No trade in the task I could parse.",
        ...(usage ? { usage } : {}),
      };
    }
    await call("get_token_info", { symbol: goal[3] });
    const result = await call("swap", {
      tokenIn: goal[2],
      tokenOut: goal[3],
      amountIn: goal[1].replaceAll(",", ""),
    });
    const usage = guardUsage();
    return {
      steps,
      stoppedBecause: "done",
      ...(usage ? { usage } : {}),
      finalMessage: result.ok ? `Bought ${goal[3]} with ${goal[1]} ${goal[2]}` : result.error,
      ...(guarded.blocked.length ? { blockedActions: guarded.blocked } : {}),
    };
  }
}
