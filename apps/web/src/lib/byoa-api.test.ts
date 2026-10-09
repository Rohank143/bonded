import { afterEach, describe, expect, it, vi } from "vitest";
import { selfServeMessage } from "@bonded/shared";
import { apiUrl, deployment } from "../config";
import { ApiError } from "./api";
import { byoaApi, streamEvents, subjectPath } from "./byoa-api";
import { byoaMessage } from "./byoa-messages";
import { snippets } from "./snippets";

function mockFetch(status = 200, body: unknown = {}) {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>(async () => ({
    ok: status < 400,
    status,
    statusText: "",
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const sent = (fetch: ReturnType<typeof mockFetch>, i = 0) => {
  const [url, init] = fetch.mock.calls[i]!;
  return {
    url,
    method: init?.method ?? "GET",
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("byoaMessage", () => {
  it("makes the same text as selfServeMessage for the existing runner-token action", () => {
    const req = { chainId: 46630, agentId: "12", timestamp: 9 };
    expect(byoaMessage({ action: "runner-token", ...req })).toBe(
      selfServeMessage({ action: "runner-token", ...req }),
    );
  });
  it("names each new action and signs its fields, one a line", () => {
    expect(
      byoaMessage({
        action: "agent-url",
        chainId: 46630,
        agentId: "12",
        fields: { url: "https://A.example/x" },
        timestamp: 5,
      }),
    ).toBe("Bonded: register agent url\nchain 46630\nagent 12\nurl https://A.example/x\ntime 5");
    expect(byoaMessage({ action: "sign-in", chainId: 46630, wallet: "0xABC", timestamp: 1 })).toBe(
      "Bonded: start preview\nchain 46630\nwallet 0xabc\ntime 1",
    );
    const titles = (["check", "notifications"] as const).map(
      (action) => byoaMessage({ action, chainId: 1, agentId: "1", timestamp: 1 }).split("\n")[0],
    );
    expect(new Set(titles).size).toBe(2);
  });
});

describe("byoaApi", () => {
  it("signs in once with the wallet and gets a session", async () => {
    const fetch = mockFetch(200, { session: "s", wallet: "0xA", expiresAt: "x" });
    const sign = vi.fn<(args: { message: string }) => Promise<`0x${string}`>>(async () => "0x5151");
    await byoaApi.signIn(sign, "0xA");
    expect(sign.mock.calls[0]![0].message).toMatch(
      /^Bonded: start preview\nchain \d+\nwallet 0xa\ntime \d+$/,
    );
    const r = sent(fetch);
    expect(r).toMatchObject({ url: `${apiUrl}/previews/session`, method: "POST" });
    expect(r.body).toMatchObject({
      chainId: deployment.chainId,
      wallet: "0xA",
      signature: "0x5151",
    });
  });

  it("uses the session for a preview's calls, with no signature", async () => {
    const fetch = mockFetch(200, {});
    const subject = { kind: "preview" as const, id: "p/1" };
    await byoaApi.createPreview("sess", { mode: "tools", connection: "url" });
    await byoaApi.registerAgentUrl(subject, { session: "sess" }, "https://a.example");
    await byoaApi.startCheck(subject, { session: "sess" });
    await byoaApi.startPreviewRating("sess", "p/1");
    const calls = fetch.mock.calls.map((_, i) => sent(fetch, i));
    expect(calls.map((c) => `${c.method} ${c.url.slice(apiUrl.length)}`)).toEqual([
      "POST /previews",
      "POST /previews/p%2F1/agent-url",
      "POST /previews/p%2F1/checks",
      "POST /previews/p%2F1/rate",
    ]);
    for (const c of calls) expect(c.headers.Authorization).toBe("Bearer sess");
    expect(calls[1]!.body).toEqual({ url: "https://a.example" });
  });

  it("signs an agent's calls in its owner's wallet", async () => {
    const fetch = mockFetch(200, {});
    const sign = vi.fn<(args: { message: string }) => Promise<`0x${string}`>>(async () => "0xbeef");
    const agent = { kind: "agent" as const, agentId: "12" };
    await byoaApi.registerAgentUrl(agent, { sign }, "https://a.example");
    await byoaApi.saveNotifications(agent, { sign }, { webhookUrl: null, email: "me@x.io" });
    expect(sign.mock.calls[0]![0].message).toMatch(
      /^Bonded: register agent url\nchain \d+\nagent 12\nurl https:\/\/a.example\ntime \d+$/,
    );
    expect(sign.mock.calls[1]![0].message).toMatch(/webhook none\nemail me@x.io/);
    const first = sent(fetch);
    expect(first.url).toBe(`${apiUrl}/self/agents/12/agent-url`);
    expect(first.headers.Authorization).toBeUndefined();
    expect(first.body).toMatchObject({ url: "https://a.example", signature: "0xbeef" });
    expect(sent(fetch, 1).method).toBe("PUT");
  });

  it("refuses to sign for a preview: it needs its session", async () => {
    mockFetch();
    await expect(
      byoaApi.startCheck({ kind: "preview", id: "p" }, { sign: async () => "0x" }),
    ).rejects.toThrow(/sign in again/);
  });

  it("keeps the API's refusal details, e.g. when to try again", async () => {
    mockFetch(429, { error: "one preview per wallet per day", retryAt: "2026-10-10T00:00:00Z" });
    const e = await byoaApi.startPreviewRating("s", "p").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).details.retryAt).toBe("2026-10-10T00:00:00Z");
  });

  it("reads the allowance without signing in", async () => {
    const fetch = mockFetch(200, { allowed: true, queued: 0 });
    await byoaApi.previewAllowance("0xAb");
    expect(sent(fetch).url).toBe(`${apiUrl}/previews/allowance?wallet=0xAb`);
  });

  it("knows each subject's path", () => {
    expect(subjectPath({ kind: "agent", agentId: "7" })).toBe("/self/agents/7");
    expect(subjectPath({ kind: "preview", id: "abc" })).toBe("/previews/abc");
  });
});

describe("streamEvents", () => {
  class FakeSource {
    static CLOSED = 2;
    static last: FakeSource;
    readyState = 1;
    onmessage?: (m: { data: string }) => void;
    onerror?: () => void;
    closed = false;
    constructor(readonly url: string) {
      FakeSource.last = this;
    }
    close() {
      this.closed = true;
    }
  }
  it("parses each event, ignores what isn't JSON, reports a dropped stream and closes", () => {
    vi.stubGlobal("EventSource", FakeSource);
    const events: unknown[] = [];
    const onError = vi.fn();
    const stop = streamEvents("/checks/c1/events", (e) => events.push(e), onError);
    expect(FakeSource.last.url).toBe(`${apiUrl}/checks/c1/events`);
    FakeSource.last.onmessage!({ data: '{"type":"started"}' });
    FakeSource.last.onmessage!({ data: "keep-alive" });
    expect(events).toEqual([{ type: "started" }]);
    FakeSource.last.onerror!();
    expect(onError).not.toHaveBeenCalled(); // still retrying
    FakeSource.last.readyState = FakeSource.CLOSED;
    FakeSource.last.onerror!();
    expect(onError).toHaveBeenCalledTimes(1);
    stop();
    expect(FakeSource.last.closed).toBe(true);
  });
  it("says so when the browser can't follow live updates", () => {
    vi.stubGlobal("EventSource", undefined);
    const onError = vi.fn();
    streamEvents("/x", () => {}, onError);
    expect(onError).toHaveBeenCalled();
  });
});

describe("snippets", () => {
  it("offers every framework, and the handler first for an Agent URL", () => {
    const labels = (c: "url" | "runner") => snippets(c, "tools").map((s) => s.label);
    expect(labels("runner")).toEqual([
      "LangChain",
      "Vercel AI SDK",
      "ElizaOS",
      "AgentKit",
      "Any MCP agent",
      "Python",
    ]);
    expect(labels("url")).toEqual([
      "Agent URL handler",
      "LangChain",
      "Vercel AI SDK",
      "ElizaOS",
      "AgentKit",
      "Python",
    ]);
  });
  it("reads the episode where the connection puts it", () => {
    const runner = snippets("runner", "tools");
    const url = snippets("url", "tools");
    expect(runner.find((s) => s.id === "langchain")!.code).toMatch(
      /isBondedEpisode\(\) \? await bondedLangChainTools\(\)/,
    );
    expect(url.find((s) => s.id === "langchain")!.code).toMatch(/bondedLangChainTools\(episode\)/);
    expect(runner.find((s) => s.id === "python")!.code).toMatch(/BONDED_TOOLS_URL/);
    expect(url.find((s) => s.id === "python")!.code).toMatch(
      /examples\/python-agent-url\/agent.py/,
    );
  });
  it("puts the real gateway in the MCP runner line, and an install line above each package", () => {
    const mcp = snippets("runner", "tools", "https://gw.example").find((s) => s.id === "mcp")!;
    expect(mcp.code).toMatch(
      /^npx @bonded\/runner --gateway https:\/\/gw.example -- sh -c 'bonded-mcp-config/,
    );
    expect(snippets("runner", "tools").find((s) => s.id === "mcp")!.code).toMatch(/<gateway>/);
    expect(snippets("runner", "tools").find((s) => s.id === "eliza")!.install).toBe(
      "npm i @bonded/sdk @elizaos/core",
    );
  });
  it("says chain mode signs its own trades", () => {
    expect(snippets("runner", "chain").find((s) => s.id === "eliza")!.note).toMatch(/session key/);
    expect(snippets("runner", "tools").find((s) => s.id === "langchain")!.note).toBeUndefined();
  });
  it("declares every @bonded/sdk import its code makes", () => {
    for (const c of ["url", "runner"] as const)
      for (const s of snippets(c, "tools"))
        for (const m of s.code.matchAll(/import \{([^}]+)\} from "(@bonded\/sdk[^"]*)"/g)) {
          const declared = s.imports.find((i) => i.from === m[2]);
          for (const name of m[1]!.split(",").map((n) => n.trim()))
            expect(declared?.names, `${s.label}: ${name} from ${m[2]}`).toContain(name);
        }
  });
});
