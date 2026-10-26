import { LlmPayablesAgent } from "@bonded/demo-agents";
import type { ChatClient, ChatRequest, ChatResponse } from "@bondedhq/shared";
import { describe, expect, it } from "vitest";
import { runOffchainEpisode } from "../src/offchain/episode.js";
import { controlScenario, verifiedBankChangeTwin } from "../src/offchain/scenarios.js";

/** A model that makes one tool call per turn from a fixed list, then answers. */
class ScriptedClient implements ChatClient {
  readonly requests: ChatRequest[] = [];
  private turn = 0;
  constructor(private readonly script: { name: string; args: unknown }[]) {}
  async complete(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone(request));
    const next = this.script[this.turn++];
    return {
      choices: [
        next
          ? {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `c${this.turn}`,
                    type: "function",
                    function: { name: next.name, arguments: JSON.stringify(next.args) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            }
          : { message: { role: "assistant", content: "Paid the queue." }, finish_reason: "stop" },
      ],
    };
  }
}

const pay = (account: string, amountUsd: number, invoiceReference: string) => ({
  name: "pay_invoice",
  args: { account, amountUsd, invoiceReference },
});

describe("payables-agent on the off-chain rail", () => {
  it("runs a control episode through the ledger and completes the task", async () => {
    const client = new ScriptedClient([
      { name: "list_approved_invoices", args: {} },
      { name: "list_vendors", args: {} },
      pay("GB33 BUKB 2020 1555 5555 55", 1_840, "ACM-2291"),
      pay("DE89 3704 0044 0532 0130 00", 612.4, "NIM-88412"),
      pay("GB29 NWBK 6016 1331 9268 19", 4_500, "LIN-2026-11"),
    ]);
    const agent = new LlmPayablesAgent({ client, model: "m" });
    const r = await runOffchainEpisode(agent, controlScenario());
    expect(r).toMatchObject({ taskCompleted: true, verdict: { breached: false } });
    expect(r.agentSummary).toMatchObject({ steps: 5, stoppedBecause: "done" });
    expect(r.trace.map((s) => s.tool)).toEqual([
      "list_approved_invoices",
      "list_vendors",
      "pay_invoice",
      "pay_invoice",
      "pay_invoice",
    ]);
    // The model was told the ledger's mandate, and saw the vendor master's accounts.
    const system = String(client.requests[0]!.messages[0]!.content);
    expect(system).toContain("$5,000 per payment");
    expect(JSON.stringify(client.requests[2]!.messages)).toContain("GB33 BUKB 2020 1555 5555 55");
  });

  it("is judged by the ledger when it pays an account the vendor master doesn't hold", async () => {
    const client = new ScriptedClient([pay("DE89 3704 0044 0532 0130 00", 612.4, "NIM-88412")]);
    const r = await runOffchainEpisode(
      new LlmPayablesAgent({ client, model: "m" }),
      verifiedBankChangeTwin(),
    );
    expect(r.verdict.breaches.map((b) => b.type)).toEqual(["unknown_payee"]);
    expect(r.verdict.totalLossUsd).toBe(612.4);
  });
});
