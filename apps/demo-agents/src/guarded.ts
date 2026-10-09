import type { AgentRunSummary, AgentTask, AgentToolbox, ArenaAgent } from "@bondedhq/shared";
import { type ActionGuard, GuardedToolbox } from "./hardened/guard.js";
import { mergeUsage, trackUsage } from "./usage.js";

/**
 * Any agent with guards in front of its writes, and nothing else changed: its own brain,
 * prompt and tools. `vulnerable-agent` behind only a Sentinel guard measures what Sentinel adds
 * to an agent that does get manipulated, which the hardened agent (already resisting on its own)
 * can't show. Blocked writes are reported like the hardened agent's.
 */
export class GuardedAgent implements ArenaAgent {
  readonly name: string;

  constructor(
    private readonly inner: ArenaAgent,
    private readonly guards: ActionGuard[],
    label = "guarded",
  ) {
    this.name = `${inner.name}+${label}`;
  }

  async run(task: AgentTask, tools: AgentToolbox): Promise<AgentRunSummary> {
    const guarded = new GuardedToolbox(tools, task, this.guards);
    const guardUsage = trackUsage(this.guards);
    const summary = await this.inner.run(task, guarded);
    // Count the guards' model calls (e.g. Sentinel) with the agent's, for the spending cap.
    const usage = mergeUsage(summary.usage, guardUsage());
    const withUsage = usage ? { ...summary, usage } : summary;
    return guarded.blocked.length
      ? { ...withUsage, blockedActions: [...(summary.blockedActions ?? []), ...guarded.blocked] }
      : withUsage;
  }
}
