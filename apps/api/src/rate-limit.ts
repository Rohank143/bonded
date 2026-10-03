/**
 * Fixed-window request limits for the API's one public write, `POST /bounties/:id/reveal`
 * (docs/AUDIT.md). Each request reads the chain, so without a limit anyone could spend the API's
 * RPC quota. Two windows: one per client address, and one shared by everyone, so rotating
 * addresses can't get around it. In memory: limits reset when the process restarts, which is
 * fine for a single API instance.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly options: {
      /** Requests one client may make per window. */
      perClient: number;
      /** Requests all clients together may make per window. */
      total: number;
      windowMs: number;
      now?: () => number;
    },
  ) {}

  /** Counts the request and returns false if it is over either limit. */
  allow(client: string): boolean {
    const now = (this.options.now ?? Date.now)();
    this.evict(now);
    const all = this.count("*", now);
    const mine = this.count(`client:${client}`, now);
    if (all.count >= this.options.total || mine.count >= this.options.perClient) return false;
    all.count++;
    mine.count++;
    return true;
  }

  private count(key: string, now: number) {
    let entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= this.options.windowMs) {
      entry = { windowStart: now, count: 0 };
      this.hits.set(key, entry);
    }
    return entry;
  }

  /** Drops expired windows so the map can't grow without bound. */
  private evict(now: number) {
    if (this.hits.size < 10_000) return;
    for (const [key, entry] of this.hits)
      if (now - entry.windowStart >= this.options.windowMs) this.hits.delete(key);
  }
}

/**
 * The caller's address as Railway's edge proxy saw it. `X-Real-IP` is set by the proxy; failing
 * that, the last `X-Forwarded-For` entry is the one the proxy appended (earlier entries come from
 * the client and can be forged).
 */
export function clientAddress(headers: { get(name: string): string | null | undefined }): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = headers.get("x-forwarded-for");
  const last = forwarded?.split(",").at(-1)?.trim();
  return last || "unknown";
}
