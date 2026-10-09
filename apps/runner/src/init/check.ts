/**
 * A client for Bonded's connection check, so `init` can run one right after connecting: start it
 * (`POST …/checks`, with the owner's session), then follow its live events (`GET
 * /checks/:id/events`) until the result. The API decides pass or fail; this only prints it.
 */

/** What a connection check streams (the API's `ConnectionCheckEvent`). */
export type CheckEvent =
  | { type: "started" }
  | { type: "tool"; name: string; surface?: string | null; ok: boolean; error?: string }
  | { type: "tx"; ok: boolean; reason?: string }
  | {
      type: "done";
      exitCode?: number | null;
      durationMs: number;
      stdoutTail?: string;
      stderrTail?: string;
    }
  | ({ type: "result" } & CheckResult);

export interface CheckResult {
  passed: boolean;
  problems: string[];
  warnings?: string[];
  taskCompleted: boolean | null;
  toolsCalled: number;
  surfacesRead: string[];
  durationMs?: number;
  codeHash?: string;
}

export interface CheckTarget {
  /** The Bonded API, e.g. https://api.bonded.example. */
  api: string;
  /** A session token from signing in (`bonded_ss_...`). */
  session: string;
  /** A preview (`/previews/:id`) or a registered agent (`/self/agents/:id`). */
  subject: { kind: "preview" | "agent"; id: string };
}

export async function runConnectionCheck(
  target: CheckTarget,
  onEvent: (event: CheckEvent) => void,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<CheckResult> {
  const fetcher = options.fetch ?? fetch;
  const base = target.api.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${target.session}` };
  const path =
    target.subject.kind === "preview"
      ? `/previews/${encodeURIComponent(target.subject.id)}/checks`
      : `/self/agents/${encodeURIComponent(target.subject.id)}/checks`;
  const started = await fetcher(`${base}${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: "{}",
  });
  const body = (await started.json().catch(() => ({}))) as {
    checkId?: string;
    error?: string;
    events?: CheckEvent[];
    result?: CheckResult | null;
  };
  if (!started.ok || !body.checkId)
    throw new Error(body.error ?? `the API answered ${started.status} to the check`);
  const seen = body.events ?? [];
  seen.forEach(onEvent);
  if (body.result) {
    if (!seen.some((e) => e.type === "result")) onEvent({ type: "result", ...body.result });
    return body.result;
  }

  const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000);
  let lastId = "";
  let skip = seen.length;
  while (Date.now() < deadline) {
    const response = await fetcher(`${base}/checks/${body.checkId}/events`, {
      headers: {
        ...headers,
        accept: "text/event-stream",
        ...(lastId ? { "last-event-id": lastId } : {}),
      },
      signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
    });
    if (!response.ok || !response.body)
      throw new Error(`the API answered ${response.status} to the check's events`);
    for await (const message of serverSentEvents(response.body)) {
      if (message.id) lastId = message.id;
      let event: CheckEvent;
      try {
        event = JSON.parse(message.data) as CheckEvent;
      } catch {
        continue;
      }
      // The first stream starts from the beginning: skip what the POST already showed.
      if (skip > 0) {
        skip--;
        continue;
      }
      onEvent(event);
      if (event.type === "result") {
        const { type: _type, ...result } = event;
        void _type;
        return result;
      }
    }
    skip = 0;
  }
  throw new Error("the check didn't finish in time; see it on your agent's page");
}

/** Server-sent events from a response body: each message's `id` and `data`. */
export async function* serverSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ id?: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | undefined;
  let data: string[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") {
        if (data.length) yield { ...(id ? { id } : {}), data: data.join("\n") };
        data = [];
        id = undefined;
      } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("id:")) id = line.slice(3).trim();
    }
  }
  if (data.length) yield { ...(id ? { id } : {}), data: data.join("\n") };
}

/** One check event as a line for the terminal (the web app's wording). */
export function eventLine(event: CheckEvent): string {
  switch (event.type) {
    case "started":
      return "Episode started: your agent got its task";
    case "tool": {
      const surface = event.surface ? ` (read ${event.surface})` : "";
      return event.ok
        ? `Called ${event.name}${surface}`
        : `Called ${event.name}${surface}: ${event.error ?? "it failed"}`;
    }
    case "tx":
      return event.ok
        ? "Sent a transaction to its vault"
        : `A transaction was refused: ${event.reason ?? "no reason given"}`;
    case "done": {
      const exit =
        event.exitCode === undefined || event.exitCode === null
          ? ""
          : `, exit code ${event.exitCode}`;
      return `Finished after ${(event.durationMs / 1000).toFixed(1)} s${exit}`;
    }
    case "result":
      return event.passed ? "The check passed" : "The check found problems";
  }
}

/** The result as lines: the verdict, then each problem and warning. */
export function resultLines(result: CheckResult): string[] {
  return [
    result.passed ? "Connection check passed: a rating will work." : "Connection check failed:",
    ...result.problems.map((p) => `  problem: ${p}`),
    ...(result.warnings ?? []).map((w) => `  warning: ${w}`),
    `  ${result.toolsCalled} tool call${result.toolsCalled === 1 ? "" : "s"}, task ${result.taskCompleted ? "done" : "not done"}${result.surfacesRead.length ? `, read ${result.surfacesRead.join(", ")}` : ""}`,
  ];
}
