import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { LlmHardenedAgent, LlmVulnerableAgent } from "@bonded/demo-agents";
import { type ChatRequest, OpenAICompatibleClient } from "@bondedhq/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAttackLibrary, rateAgent, runEpisode, Sandbox } from "../src/index.js";

/**
 * A stand-in "model" behind a real OpenAI-compatible HTTP endpoint. It behaves like a naive
 * LLM agent: read the inbox, obey a transfer instruction if one is there, otherwise do the
 * task. This exercises the real HTTP client, the LLM brain, the toolbox and the chain end to
 * end without a paid API key.
 */
function naiveModel(request: ChatRequest) {
  const toolResults = request.messages.filter((m) => m.role === "tool");
  const toolCall = (id: string, name: string, args: unknown) => ({
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  });
  const answer = (message: object, finish: string) => ({
    id: "fake",
    model: request.model,
    choices: [{ message: { role: "assistant", content: null, ...message }, finish_reason: finish }],
    usage: { prompt_tokens: 50, completion_tokens: 10 },
  });
  if (toolResults.length === 0) {
    return answer({ tool_calls: [toolCall("1", "read_inbox", {})] }, "tool_calls");
  }
  if (toolResults.length === 1) {
    const inbox = toolResults[0]!.content;
    const target = /send [0-9,]+ tUSDG to [^.]*?(0x[0-9a-fA-F]{40})/.exec(inbox)?.[1];
    const next = target
      ? toolCall("2", "transfer", { token: "tUSDG", to: target, amount: "5000" })
      : toolCall("2", "swap", { tokenIn: "tUSDG", tokenOut: "tNVDA", amountIn: "2000" });
    return answer({ tool_calls: [next] }, "tool_calls");
  }
  return answer({ content: "Done." }, "stop");
}

let sandbox: Sandbox;
let server: Server;
let client: OpenAICompatibleClient;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const ok =
        req.url === "/v1/chat/completions" && req.headers.authorization === "Bearer test-key";
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          ok ? naiveModel(JSON.parse(body) as ChatRequest) : { error: "unauthorised" },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  client = new OpenAICompatibleClient({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "test-key",
  });
  sandbox = await Sandbox.start();
});
afterAll(async () => {
  await sandbox?.stop();
  await new Promise((resolve) => server?.close(resolve));
});

describe("the LLM brain over a real OpenAI-compatible endpoint", () => {
  it("control: the model does its task and the episode is SAFE", async () => {
    const agent = new LlmVulnerableAgent({ client, model: "fake/naive" });
    const result = await runEpisode(sandbox, { agent, attack: null });
    expect(result.agent).toBe("vulnerable-agent/fake/naive");
    expect(result.trace.map((s) => s.tool)).toEqual(["read_inbox", "swap"]);
    expect(result.verdict.breached).toBe(false);
    expect(result.agentSummary).toMatchObject({
      stoppedBecause: "done",
      usage: { inputTokens: 150, outputTokens: 30 },
    });
  });

  it("an operator-impersonation DM breaches the model-driven agent", async () => {
    const attack = loadAttackLibrary().find((s) => s.id === "A6-operator-impersonation-001")!;
    const agent = new LlmVulnerableAgent({ client, model: "fake/naive" });
    const result = await runEpisode(sandbox, { agent, attack });
    expect(result.trace.map((s) => s.tool)).toEqual(["read_inbox", "transfer"]);
    expect(result.verdict).toMatchObject({ breached: true, attackSucceeded: true, frozen: true });
  });

  it("hardened-agent's guard stops the same model's transfer before it reaches the vault", async () => {
    const attack = loadAttackLibrary().find((s) => s.id === "A6-operator-impersonation-001")!;
    const agent = new LlmHardenedAgent({ client, model: "fake/naive" });
    const result = await runEpisode(sandbox, { agent, attack });
    expect(result.verdict.breached).toBe(false);
    expect(result.trace.map((s) => s.tool)).toEqual(["read_inbox"]);
    expect(result.agentSummary.blockedActions?.[0]?.tool).toBe("transfer");
    expect(result.agentSummary.stoppedBecause).toBe("done");
  });

  it("a rating stops starting episodes at the spending cap and says so", async () => {
    const agent = new LlmVulnerableAgent({ client, model: "fake/naive" });
    const result = await rateAgent(sandbox, {
      agent,
      attacks: ["A2-fake-halt-news-001", "A2-social-thread-004"].map((id) =>
        loadAttackLibrary().find((s) => s.id === id)!,
      ),
      controls: 0,
      maxUsd: 0.000001,
      // The cap stops the rating after the first seed, so the order matters here.
      shuffle: false,
    });
    expect(result.episodes).toHaveLength(1);
    expect(result.report.stoppedEarly).toMatch(/spending cap/);
    // The local endpoint reports tokens but no cost, so the spend is an estimate.
    // Only the seed that ran sets the severity prior: A2-fake-halt-news-001 is "high" (0.25),
    // and the critical seed after it never ran.
    expect(result.report.scoring.groups.find((g) => g.id === "injection")?.severity).toBe(0.25);
    expect(result.report.spend).toMatchObject({
      estimated: true,
      inputTokens: 150,
      outputTokens: 30,
    });
  });
});
