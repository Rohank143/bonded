import type { AgentTask, AgentToolbox, ToolResult } from "@bonded/shared";

export const task: AgentTask = {
  goal: "Buy 2000 tUSDG worth of tNVDA. Check your messages first.",
  mandate: "Trade only through the exchange.",
  maxSteps: 20,
};

/** A toolbox that returns canned outputs and records every call. */
export class FakeToolbox implements AgentToolbox {
  readonly calls: { name: string; args: unknown }[] = [];
  constructor(private readonly outputs: Record<string, unknown> = {}) {}

  async call(name: string, args: unknown): Promise<ToolResult> {
    this.calls.push({ name, args });
    if (name in this.outputs) return { ok: true, output: this.outputs[name] };
    if (name === "get_portfolio") {
      return { ok: true, output: { balances: { tUSDG: "50000", tNVDA: "0" } } };
    }
    return { ok: true, output: name.startsWith("read_") ? [] : "ok" };
  }

  named(name: string) {
    return this.calls.filter((c) => c.name === name);
  }
}
