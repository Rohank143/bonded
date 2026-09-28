import { describe, expect, it } from "vitest";
import {
  agentToolDefinitions,
  LlmError,
  llmConfigFromEnv,
  OPENROUTER_BASE_URL,
  OpenAICompatibleClient,
} from "../src/index.js";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const reply = {
  choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
};

/** A fetch that replays responses and records each request. */
function fakeFetch(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("llmConfigFromEnv", () => {
  it("defaults to OpenRouter and accepts either key name", () => {
    expect(llmConfigFromEnv({ OPENROUTER_API_KEY: "or-key" })).toEqual({
      baseUrl: OPENROUTER_BASE_URL,
      apiKey: "or-key",
    });
    expect(
      llmConfigFromEnv({ LLM_API_KEY: "k", LLM_BASE_URL: "http://localhost:11434/v1/" }),
    ).toEqual({ baseUrl: "http://localhost:11434/v1", apiKey: "k" });
  });

  it("fails clearly without a key", () => {
    expect(() => llmConfigFromEnv({})).toThrow(/OPENROUTER_API_KEY/);
  });
});

describe("OpenAICompatibleClient", () => {
  it("posts a chat completion with auth, and asks OpenRouter for the cost", async () => {
    const { impl, calls } = fakeFetch(ok(reply));
    const client = new OpenAICompatibleClient(
      { baseUrl: OPENROUTER_BASE_URL, apiKey: "k" },
      { fetch: impl },
    );
    const response = await client.complete({
      model: "m",
      messages: [{ role: "user", content: "x" }],
    });
    expect(response.choices[0]?.message.content).toBe("hi");
    expect(calls[0]?.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer k");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      model: "m",
      usage: { include: true },
    });
  });

  it("sends a plain request to other endpoints", async () => {
    const { impl, calls } = fakeFetch(ok(reply));
    const client = new OpenAICompatibleClient(
      { baseUrl: "http://localhost:8000/v1", apiKey: "k" },
      { fetch: impl },
    );
    await client.complete({ model: "m", messages: [] });
    expect(JSON.parse(String(calls[0]?.init.body))).not.toHaveProperty("usage");
  });

  it("retries rate limits, server errors and dropped connections", async () => {
    const { impl, calls } = fakeFetch(
      new Response("slow down", { status: 429 }),
      new Error("socket hang up"),
      ok(reply),
    );
    const client = new OpenAICompatibleClient(
      { baseUrl: OPENROUTER_BASE_URL, apiKey: "k" },
      { fetch: impl, retryDelayMs: 1 },
    );
    await expect(client.complete({ model: "m", messages: [] })).resolves.toMatchObject(reply);
    expect(calls).toHaveLength(3);
  });

  it("does not retry client errors, and reports the status and body", async () => {
    const { impl, calls } = fakeFetch(new Response("unknown model", { status: 400 }));
    const client = new OpenAICompatibleClient(
      { baseUrl: OPENROUTER_BASE_URL, apiKey: "k" },
      { fetch: impl, retryDelayMs: 1 },
    );
    const error = await client.complete({ model: "nope", messages: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ status: 400, message: expect.stringContaining("unknown model") });
    expect(calls).toHaveLength(1);
  });

  it("gives up after the retry budget", async () => {
    const { impl, calls } = fakeFetch(
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
    );
    const client = new OpenAICompatibleClient(
      { baseUrl: OPENROUTER_BASE_URL, apiKey: "k" },
      { fetch: impl, retryDelayMs: 1, maxRetries: 2 },
    );
    await expect(client.complete({ model: "m", messages: [] })).rejects.toMatchObject({
      status: 503,
    });
    expect(calls).toHaveLength(3);
  });
});

describe("agentToolDefinitions", () => {
  it("describes every agent tool as a function with a JSON schema", () => {
    const defs = agentToolDefinitions();
    expect(defs.map((d) => d.function.name)).toContain("transfer");
    for (const def of defs) {
      expect(def.type).toBe("function");
      expect(def.function.parameters).toMatchObject({ type: "object" });
    }
  });
});
