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
