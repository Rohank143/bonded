import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

/** What one poll of a stream found: events to send, and whether the stream is over. */
export interface PollResult {
  /** No `event` name: a plain message, which EventSource.onmessage receives. */
  events: { id?: string; event?: string; data: unknown }[];
  done: boolean;
}

/**
 * Server-sent event streams that poll the database (a check's events, a rating's progress). They
 * borrow a pool connection only for each poll, so they never hold one; the number open at once
 * is capped, and each stream ends by itself after `maxMs`.
 */
export class PollStreams {
  private readonly active = new Set<AbortController>();
  /** Streams open per client address, and per thing streamed (a check, a rating). */
  private readonly perClient = new Map<string, number>();
  private readonly perKey = new Map<string, number>();
  private closing = false;

  constructor(
    private readonly limit = 50,
    private readonly limits = { perClient: 4, perKey: 3 },
  ) {}

  open(
    c: Context,
    poll: () => Promise<PollResult>,
    options: { intervalMs?: number; maxMs?: number; client?: string; key?: string } = {},
  ): Response | Promise<Response> {
    const client = options.client ?? "unknown";
    const key = options.key ?? "";
    if (this.closing || this.active.size >= this.limit)
      return c.json({ error: "too many live streams open; try again shortly" }, 503);
    if ((this.perClient.get(client) ?? 0) >= this.limits.perClient)
      return c.json({ error: "too many live streams open from here; close one first" }, 429);
    if (key && (this.perKey.get(key) ?? 0) >= this.limits.perKey)
      return c.json({ error: "too many live streams open for this; close one first" }, 429);
    const bump = (map: Map<string, number>, k: string, by: number) => {
      const n = (map.get(k) ?? 0) + by;
      if (n > 0) map.set(k, n);
      else map.delete(k);
    };
    bump(this.perClient, client, 1);
    if (key) bump(this.perKey, key, 1);
    const abort = new AbortController();
    this.active.add(abort);
    const stop = () => abort.abort();
    c.req.raw.signal.addEventListener("abort", stop, { once: true });
    const intervalMs = options.intervalMs ?? 1000;
    const until = Date.now() + (options.maxMs ?? 30 * 60_000);
    return streamSSE(
      c,
      async (stream) => {
        stream.onAbort(stop);
        try {
          while (!abort.signal.aborted && Date.now() < until) {
            const { events, done } = await poll();
            for (const e of events) {
              if (abort.signal.aborted) break;
              await stream.writeSSE({
                ...(e.id ? { id: e.id } : {}),
                ...(e.event ? { event: e.event } : {}),
                data: JSON.stringify(e.data),
              });
            }
            if (done || abort.signal.aborted) break;
            await stream.writeSSE({ event: "heartbeat", data: "{}" });
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, intervalMs);
              abort.signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true },
              );
            });
          }
        } finally {
          c.req.raw.signal.removeEventListener("abort", stop);
          if (this.active.delete(abort)) {
            bump(this.perClient, client, -1);
            if (key) bump(this.perKey, key, -1);
          }
        }
      },
      async () => {
        stop();
      },
    );
  }

  /** Streams open now (for tests). */
  get size() {
    return this.active.size;
  }

  /** End every stream; refuse new ones. */
  close() {
    this.closing = true;
    for (const abort of this.active) abort.abort();
  }
}
