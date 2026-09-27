import type {
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it } from "vitest";
import { ClaudeVulnerableAgent, type MessagesClient } from "../src/index.js";
import { FakeToolbox, task } from "./fakes.js";

type Block = BetaMessage["content"][number];

function message(stop_reason: BetaMessage["stop_reason"], content: unknown[]): BetaMessage {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    stop_reason,
    content,
  } as unknown as BetaMessage;
}
const toolUse = (id: string, name: string, input: unknown) =>
  ({ type: "tool_use", id, name, input }) as unknown as Block;

/** Replays scripted responses and keeps each request for inspection. */
class FakeClient implements MessagesClient {
  readonly requests: MessageCreateParamsNonStreaming[] = [];
  constructor(private readonly responses: BetaMessage[]) {}
  beta = {
    messages: {
      create: async (params: MessageCreateParamsNonStreaming) => {
        this.requests.push(structuredClone(params));
        const next = this.responses.shift();
        if (!next) throw new Error("no more scripted responses");
        return next;
      },
    },
  };
}

describe("ClaudeVulnerableAgent", () => {
  it("runs a tool loop through the toolbox and stops at end_turn", async () => {
    const client = new FakeClient([
      message("tool_use", [toolUse("t1", "read_inbox", {}), toolUse("t2", "get_prices", {})]),
      message("tool_use", [
        toolUse("t3", "swap", { tokenIn: "tUSDG", tokenOut: "tNVDA", amountIn: "2000" }),
      ]),
      message("end_turn", [{ type: "text", text: "Bought tNVDA." }]),
    ]);
    const tools = new FakeToolbox();
    const summary = await new ClaudeVulnerableAgent({ client }).run(task, tools);

    expect(tools.calls.map((c) => c.name)).toEqual(["read_inbox", "get_prices", "swap"]);
    expect(summary).toEqual({ steps: 3, stoppedBecause: "done", finalMessage: "Bought tNVDA." });

    const first = client.requests[0]!;
    expect(first.model).toBe("claude-opus-5");
    expect(first.fallbacks).toBe("default");
    expect(first.betas).toContain("server-side-fallback-2026-07-01");
    expect(first.tools?.map((t) => ("name" in t ? t.name : ""))).toContain("transfer");
    // Both results of the parallel calls go back in one user message.
    const second = client.requests[1]!;
    const lastUser = second.messages.at(-1)!;
    expect(lastUser.role).toBe("user");
    expect(Array.isArray(lastUser.content) && lastUser.content.length).toBe(2);
  });

  it("returns tool failures to the model as errors", async () => {
    const client = new FakeClient([
      message("tool_use", [toolUse("t1", "get_token_info", { symbol: "tNVDA" })]),
      message("end_turn", [{ type: "text", text: "done" }]),
    ]);
    const tools = new FakeToolbox();
    tools.call = async (name, args) => {
      tools.calls.push({ name, args });
      return { ok: false, error: "no token listed" };
    };
    await new ClaudeVulnerableAgent({ client }).run(task, tools);
    const result = client.requests[1]!.messages.at(-1)!.content;
    expect(result).toEqual([
      expect.objectContaining({
        tool_use_id: "t1",
        is_error: true,
        content: '{"error":"no token listed"}',
      }),
    ]);
  });

  it("stops at the step limit", async () => {
    const calls = Array.from({ length: 5 }, (_, i) => toolUse(`t${i}`, "read_news", {}));
    const client = new FakeClient([message("tool_use", calls)]);
    const tools = new FakeToolbox();
    const summary = await new ClaudeVulnerableAgent({ client }).run(
      { ...task, maxSteps: 3 },
      tools,
    );
    expect(tools.calls).toHaveLength(3);
    expect(summary).toEqual({ steps: 3, stoppedBecause: "max_steps" });
  });

  it("ends the episode on a refusal", async () => {
    const client = new FakeClient([message("refusal", [])]);
    const summary = await new ClaudeVulnerableAgent({ client }).run(task, new FakeToolbox());
    expect(summary).toMatchObject({ stoppedBecause: "error", steps: 0 });
  });

  it("treats a response cut off at max_tokens as an error, not a finish", async () => {
    const client = new FakeClient([message("max_tokens", [{ type: "text", text: "I will now" }])]);
    const summary = await new ClaudeVulnerableAgent({ client }).run(task, new FakeToolbox());
    expect(summary).toEqual({
      steps: 0,
      stoppedBecause: "error",
      finalMessage: "the model stopped early (max_tokens)",
    });
  });

  it("stops without calling the model once the episode has ended", async () => {
    const client = new FakeClient([message("end_turn", [])]);
    const tools = new FakeToolbox();
    const controller = new AbortController();
    controller.abort();
    Object.assign(tools, { signal: controller.signal });
    const summary = await new ClaudeVulnerableAgent({ client }).run(task, tools);
    expect(summary.stoppedBecause).toBe("error");
    expect(client.requests).toHaveLength(0);
  });

  it("passes the episode's abort signal to the API request", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const client: MessagesClient = {
      beta: {
        messages: {
          create: async (_params, options) => {
            seen.push(options?.signal);
            return message("end_turn", []);
          },
        },
      },
    };
    const tools = new FakeToolbox();
    const signal = new AbortController().signal;
    Object.assign(tools, { signal });
    await new ClaudeVulnerableAgent({ client }).run(task, tools);
    expect(seen).toEqual([signal]);
  });

  it("continues after pause_turn", async () => {
    const client = new FakeClient([
      message("pause_turn", []),
      message("end_turn", [{ type: "text", text: "ok" }]),
    ]);
    const summary = await new ClaudeVulnerableAgent({ client }).run(task, new FakeToolbox());
    expect(summary.stoppedBecause).toBe("done");
    expect(client.requests).toHaveLength(2);
  });
});
