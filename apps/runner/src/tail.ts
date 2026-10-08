/** Keeps the last `limit` bytes written to it: an agent's output can be any size. */
export class Tail {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size - (this.chunks[0]?.length ?? 0) >= this.limit && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
  }

  /** The kept bytes as text (a character cut at the start shows as a replacement mark). */
  text(): string {
    const all = Buffer.concat(this.chunks);
    return all.subarray(Math.max(0, all.length - this.limit)).toString("utf8");
  }
}

/** Reconnect delays: doubling from `initialMs` up to `maxMs`, with up to 20% jitter either way. */
export function backoffDelay(
  attempt: number,
  options: { initialMs: number; maxMs: number },
  random: () => number = Math.random,
): number {
  const base = Math.min(options.maxMs, options.initialMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + 0.4 * random()));
}

/**
 * Why a gateway URL can't be used, or undefined when it can. The runner sends its token over this
 * connection, so it must be https; plain http is allowed only to this machine (a local Arena).
 */
export function gatewayUrlProblem(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "the gateway URL isn't a URL";
  }
  if (url.protocol === "https:") return undefined;
  if (url.protocol !== "http:") return "the gateway URL must be https";
  const host = url.hostname.toLowerCase();
  const local =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(\.[0-9]{1,3}){3}$/.test(host);
  return local ? undefined : "the gateway URL must be https (plain http only to localhost)";
}
