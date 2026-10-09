import { describe, expect, it } from "vitest";
import { type CheckEvent, eventLine, resultLines, runConnectionCheck } from "../src/init/check.js";

const RESULT = {
  passed: true,
  problems: [],
  warnings: ["It read only 2 of 9 surfaces"],
  taskCompleted: true,
  toolsCalled: 3,
  surfacesRead: ["inbox", "news"],
};

/** A stand-in Bonded API: POST …/checks, then the events as server-sent events. */
function fakeApi(events: CheckEvent[], options: { status?: number; immediate?: boolean } = {}) {
  const calls: { url: string; method: string; auth: string | null; body?: string }[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    calls.push({
      url,
      method: init.method ?? "GET",
      auth: headers.get("authorization"),
      ...(typeof init.body === "string" ? { body: init.body } : {}),
    });
    if (url.endsWith("/checks"))
      return Response.json(
        options.status
          ? { error: "Run a check later." }
          : {
              checkId: "c1",
              events: options.immediate ? events : [],
              result: options.immediate ? RESULT : null,
            },
        { status: options.status ?? 201 },
      );
    // Split mid-message, as a real stream may.
    const text = events.map((e, i) => `id: ${i + 1}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    const cut = Math.floor(text.length / 2);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text.slice(0, cut)));
        c.enqueue(new TextEncoder().encode(text.slice(cut)));
        c.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const target = {
  api: "https://api.test/",
  session: "bonded_ss_abc",
  subject: { kind: "preview" as const, id: "p 1" },
};

describe("runConnectionCheck", () => {
  it("starts a check with the session and follows its events to the result", async () => {
    const events: CheckEvent[] = [
      { type: "started" },
      { type: "tool", name: "read_inbox", surface: "inbox", ok: true },
      { type: "done", exitCode: 0, durationMs: 4200 },
      { type: "result", ...RESULT },
    ];
    const api = fakeApi(events);
    const seen: string[] = [];
    const result = await runConnectionCheck(target, (e) => seen.push(eventLine(e)), {
      fetch: api.fetch,
    });
    expect(result).toEqual(RESULT);
    expect(seen).toEqual([
      "Episode started: your agent got its task",
      "Called read_inbox (read inbox)",
      "Finished after 4.2 s, exit code 0",
      "The check passed",
    ]);
    expect(api.calls[0]).toEqual({
      url: "https://api.test/previews/p%201/checks",
      method: "POST",
      auth: "Bearer bonded_ss_abc",
      body: "{}",
    });
    expect(api.calls[1]).toMatchObject({
      url: "https://api.test/checks/c1/events",
      auth: "Bearer bonded_ss_abc",
    });
  });

  it("returns at once when the check failed before it ran, for a registered agent", async () => {
    const api = fakeApi([], { immediate: true });
    const result = await runConnectionCheck(
      { ...target, subject: { kind: "agent", id: "12" } },
      () => {},
      {
        fetch: api.fetch,
      },
    );
    expect(result).toEqual(RESULT);
    expect(api.calls.map((c) => c.url)).toEqual(["https://api.test/self/agents/12/checks"]);
  });

  it("passes the API's refusal on", async () => {
    const api = fakeApi([], { status: 429 });
    await expect(runConnectionCheck(target, () => {}, { fetch: api.fetch })).rejects.toThrow(
      "Run a check later.",
    );
  });

  it("prints the result with its problems and warnings", () => {
    expect(
      resultLines({ ...RESULT, passed: false, problems: ["Your agent never called a tool"] }),
    ).toEqual([
      "Connection check failed:",
      "  problem: Your agent never called a tool",
      "  warning: It read only 2 of 9 surfaces",
      "  3 tool calls, task done, read inbox, news",
    ]);
  });
});
