import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { Database, json, type Connection } from "@bonded/db";

/** Bounds listener connections and owns their lifetime, including setup and slow HTTP readers. */
export class EventStreams {
  private readonly active = new Map<AbortController, Promise<void>>();
  private closing = false;

  constructor(
    private readonly db: Database,
    private readonly limit = 5,
  ) {}

  /** Reserve before acquiring a client so simultaneous requests cannot exceed the limit. */
  async open(c: Context, after: string, runId?: string): Promise<Response> {
    if (this.closing || this.active.size >= this.limit)
      return c.json({ error: "event stream capacity unavailable" }, 503);
    const abort = new AbortController();
    let resolveDone!: () => void;
    this.active.set(
      abort,
      new Promise<void>((resolve) => {
        resolveDone = resolve;
      }),
    );
    let listener: Connection | undefined;
    const stop = () => abort.abort();
    const cleanup = () => {
      c.req.raw.signal.removeEventListener("abort", stop);
      // Destroy rather than returning a LISTEN session to the general pool. This also bounds
      // shutdown if the backend stopped responding while the stream was being cancelled.
      if (listener) {
        listener.release(true);
        listener.off("error", stop);
        listener.off("end", stop);
      }
      this.active.delete(abort);
      resolveDone();
    };
    c.req.raw.signal.addEventListener("abort", stop, { once: true });
    if (c.req.raw.signal.aborted) stop();
    try {
      listener = await this.db.pool.connect();
      listener.on("error", stop);
      listener.on("end", stop);
      const listenQuery = { text: "LISTEN bonded_events", query_timeout: 5000 };
      await listener.query(listenQuery);
      if (abort.signal.aborted) {
        cleanup();
        return c.json({ error: "event stream closed" }, 503);
      }
    } catch (error) {
      cleanup();
      throw error;
    }
    const client = listener;
    return streamSSE(
      c,
      async (stream) => {
        let cursor = after;
        let wake: (() => void) | undefined;
        const notify = () => wake?.();
        const cancel = () => {
          stream.abort();
          notify();
        };
        abort.signal.addEventListener("abort", cancel, { once: true });
        stream.onAbort(stop);
        client.on("notification", notify);
        if (abort.signal.aborted) cancel();
        try {
          while (!abort.signal.aborted) {
            // Reuse the reserved listener; streams never compete for additional pool clients.
            const eventQuery = {
              text: "SELECT id,topic,payload FROM events WHERE id>$1 ORDER BY id LIMIT 100",
              values: [cursor],
              query_timeout: 5000,
            };
            const rows = await client.query(eventQuery);
            for (const row of rows.rows) {
              if (abort.signal.aborted) break;
              if (!runId || row.payload.runId === runId)
                await stream.writeSSE({ id: row.id, event: row.topic, data: json(row.payload) });
              cursor = row.id;
            }
            if (rows.rowCount === 100) continue;
            if (abort.signal.aborted) break;
            await stream.writeSSE({ event: "heartbeat", data: "{}" });
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 1000);
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
              if (abort.signal.aborted) wake();
            });
            wake = undefined;
          }
        } finally {
          abort.signal.removeEventListener("abort", cancel);
          client.off("notification", notify);
          cleanup();
        }
      },
      async () => {
        stop();
      },
    );
  }

  /** Reject new streams, cancel blocked writes, and await listener release before pool shutdown. */
  async close(): Promise<void> {
    this.closing = true;
    const pending = [...this.active.values()];
    for (const abort of this.active.keys()) abort.abort();
    await Promise.all(pending);
  }
}
