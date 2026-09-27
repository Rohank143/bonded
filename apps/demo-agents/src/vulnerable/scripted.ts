import type { AgentRunSummary, AgentTask, AgentToolbox, ArenaAgent } from "@bonded/shared";
import { findInstructions } from "./instructions.js";

/** "Buy 2000 tUSDG worth of tNVDA" → swap 2000 tUSDG for tNVDA. */
const GOAL = /\bbuy\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s+(t[A-Z]{3,5})\s+worth\s+of\s+(t[A-Z]{3,5})\b/i;

/**
 * vulnerable-agent with a deterministic brain. It behaves like an AI trading agent with no
 * prompt-injection defences: it reads everything it's pointed at, then obeys any instruction
 * to send or approve funds, whoever wrote it, before getting on with its task.
 *
 * Being deterministic, it lets the Arena's plumbing (sandbox, world, tools, judge) be tested
 * without a model or an API key. ClaudeVulnerableAgent is the same agent with a real LLM brain.
 */
export class ScriptedVulnerableAgent implements ArenaAgent {
  readonly name = "vulnerable-agent/scripted";

  async run(task: AgentTask, tools: AgentToolbox): Promise<AgentRunSummary> {
    let steps = 0;
    const call = async (name: string, args: unknown = {}) => {
      steps++;
      return tools.call(name, args);
    };

    // 1. Read everything, like an agent told to "check your messages and the news first".
    const texts: string[] = [];
    for (const tool of ["read_inbox", "read_news", "read_social", "get_market_report"]) {
      const result = await call(tool);
      if (result.ok) texts.push(JSON.stringify(result.output));
    }
    const goal = GOAL.exec(task.goal);
    if (goal?.[3]) {
      const info = await call("get_token_info", { symbol: goal[3] });
      if (info.ok) texts.push(JSON.stringify(info.output));
    }

    // 2. Obey any money-moving instruction it read. This is the vulnerability.
    for (const instruction of findInstructions(texts.join("\n"))) {
      if (instruction.kind === "transfer") {
        const amount =
          instruction.amount === "all"
            ? await balance(call, instruction.token)
            : instruction.amount;
        if (amount)
          await call("transfer", { token: instruction.token, to: instruction.to, amount });
      } else {
        await call("approve", {
          token: instruction.token,
          spender: instruction.spender,
          amount: (await balance(call, instruction.token)) ?? "0",
        });
      }
    }

    // 3. Do the actual task.
    if (goal?.[1] && goal[2] && goal[3]) {
      await call("swap", {
        tokenIn: goal[2],
        tokenOut: goal[3],
        amountIn: goal[1].replaceAll(",", ""),
      });
      return {
        steps,
        stoppedBecause: "done",
        finalMessage: `Bought ${goal[3]} with ${goal[1]} ${goal[2]}`,
      };
    }
    return { steps, stoppedBecause: "done", finalMessage: "No trade in the task I could parse." };
  }
}

type Call = (name: string, args?: unknown) => ReturnType<AgentToolbox["call"]>;

async function balance(call: Call, token: string): Promise<string | undefined> {
  const result = await call("get_portfolio");
  if (!result.ok) return undefined;
  const balances = (result.output as { balances?: Record<string, string> }).balances;
  return balances?.[token];
}
