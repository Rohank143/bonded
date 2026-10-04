import type { Database } from "@bonded/db";
import type { ServiceChain } from "@bonded/keeper";
import { formatEther } from "viem";

/**
 * Operations alerts to a Telegram chat (issue #24, docs/SERVICES.md "Alerts"): crashes, failing
 * service loops, a lagging keeper, stuck claims, failed ratings and failed premium accruals.
 * Messages are built only from fixed text and ids (never error messages, which can carry the RPC
 * URL and its key, and never attack payloads), and they are rate-limited.
 */
export interface AlertSink {
  send(text: string): Promise<void>;
}

/** Sends through the Telegram Bot API. The token is only ever part of the request URL. */
export class TelegramSink implements AlertSink {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(text: string): Promise<void> {
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    // The status only: the response body and the URL stay out of errors and logs.
    if (!response.ok) throw new Error(`Telegram answered ${response.status}`);
  }
}

/** The sink from TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or none when they aren't set. */
export function telegramFromEnv(env: NodeJS.ProcessEnv = process.env): AlertSink | undefined {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return undefined;
  return new TelegramSink(token, chatId);
}

export interface AlerterOptions {
  /** Shown first in every message, e.g. "keeper (Robinhood testnet)". */
  source: string;
  /** The same alert key is sent at most once per this period (default 30 minutes). */
  repeatMs?: number;
  /** At most this many messages per hour across all keys (default 20). */
  maxPerHour?: number;
  now?: () => number;
}

/** Sends alerts through a sink with per-key and overall limits. Never throws. */
export class Alerter {
  private readonly lastSent = new Map<string, number>();
  private readonly sentAt: number[] = [];

  constructor(
    private readonly sink: AlertSink | undefined,
    private readonly options: AlerterOptions,
  ) {}

  get enabled(): boolean {
    return this.sink !== undefined;
  }

  /** Sends `text` under `key` unless that key was sent recently or the hourly cap is reached. */
  async alert(key: string, text: string): Promise<boolean> {
    if (!this.sink) return false;
    const now = (this.options.now ?? Date.now)();
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < (this.options.repeatMs ?? 30 * 60_000)) return false;
    while (this.sentAt.length && now - this.sentAt[0]! >= 3_600_000) this.sentAt.shift();
    if (this.sentAt.length >= (this.options.maxPerHour ?? 20)) return false;
    this.lastSent.set(key, now);
    this.sentAt.push(now);
    try {
      await this.sink.send(`[${this.options.source}] ${text}`.slice(0, 1000));
      return true;
    } catch (e) {
      // Our own status message, or just the error's class: a network error can carry the URL.
      const reason =
        e instanceof Error ? (e.message.startsWith("Telegram") ? e.message : e.name) : "unknown";
      console.error("alert not sent:", reason);
      return false;
    }
  }

  /** Lets `key` alert again at once, e.g. after the problem clears. */
  reset(key: string): void {
    this.lastSent.delete(key);
  }
}

/**
 * Counts consecutive failures of a service loop: alerts after `threshold` in a row, and once
 * more when it recovers.
 */
export class LoopHealth {
  private failures = 0;
  private alerted = false;

  constructor(
    private readonly alerter: Alerter,
    private readonly name: string,
    private readonly threshold = 3,
  ) {}

  async failed(error: unknown): Promise<void> {
    this.failures++;
    if (this.failures < this.threshold) return;
    // The error's class name only; its message can carry the RPC URL and its key.
    const kind = error instanceof Error ? error.name : "unknown error";
    if (
      await this.alerter.alert(
        `loop:${this.name}`,
        `${this.name} has failed ${this.failures} times in a row (${kind}). It keeps retrying.`,
      )
    )
      this.alerted = true;
  }

  async succeeded(): Promise<void> {
    if (this.alerted) {
      this.alerter.reset(`loop:${this.name}`);
      await this.alerter.alert(`loop:${this.name}:ok`, `${this.name} is working again.`);
    }
    this.failures = 0;
    this.alerted = false;
  }
}

/** Event topics that each mean something failed, with the ids that are safe to show. */
const FAILURE_TOPICS: Record<string, { text: string; fields: string[] }> = {
  "rating.failed": { text: "A rating failed", fields: ["runId"] },
  "keeper.accrual_failed": {
    text: "Premium accrual failed",
    fields: ["chainId", "policyId"],
  },
  "solana.claim.failed": { text: "A Solana claim failed", fields: ["policy", "breachId"] },
  "bounty.failed": { text: "A bounty validation failed", fields: ["submissionId"] },
};

export interface WatchdogOptions {
  /** Alert when the keeper's scanned block is older than the head by this (default 10 minutes)... */
  maxLagMs?: number;
  /** ...and more than this many blocks behind (default 100), so an idle chain doesn't alert. */
  maxLagBlocks?: bigint;
  /**
   * Alert when the keeper's own wallet holds less gas than this, in wei (default 0.002 ETH,
   * a few dozen claims). Without gas every claim fails and retries; Day 14 found that the hard way.
   */
  minGasWei?: bigint;
  /** Alert when a breach has been pending with an error for this long (default 10 minutes). */
  stuckClaimMs?: number;
  now?: () => number;
}

/**
 * Checks the keeper's progress and the event log once per call. Runs in the keeper service,
 * which is deployed once.
 */
export class Watchdog {
  private lastEventId: string | undefined;
  /** When each pending breach was first seen with an error, so restarts only delay an alert. */
  private readonly erroringSince = new Map<string, number>();

  constructor(
    private readonly db: Database,
    private readonly chain: ServiceChain,
    private readonly alerter: Alerter,
    private readonly options: WatchdogOptions = {},
  ) {}

  async check(): Promise<void> {
    await this.checkGas();
    await this.checkLag();
    await this.checkStuckClaims();
    await this.checkFailureEvents();
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  private async checkGas() {
    const address = this.chain.wallet.account.address;
    const balance = await this.chain.read.getBalance({ address });
    const min = this.options.minGasWei ?? 2_000_000_000_000_000n;
    if (balance < min) {
      await this.alerter.alert(
        "keeper-gas",
        `The keeper's wallet ${address} is low on gas: ${formatEther(balance)} ETH. Claims and premium accruals fail without it; send it test ETH.`,
      );
    } else this.alerter.reset("keeper-gas");
  }

  private async checkLag() {
    const chainId = this.chain.deployment.chainId;
    const cursor = (
      await this.db.pool.query("SELECT block_number FROM keeper_cursors WHERE chain_id=$1", [
        chainId,
      ])
    ).rows[0];
    if (!cursor) return; // not started yet
    const [scanned, head] = await Promise.all([
      this.chain.read.getBlock({ blockNumber: BigInt(cursor.block_number) }),
      this.chain.read.getBlock(),
    ]);
    const lagMs = Number(head.timestamp - scanned.timestamp) * 1000;
    const maxLagMs = this.options.maxLagMs ?? 10 * 60_000;
    if (lagMs > maxLagMs && head.number - scanned.number > (this.options.maxLagBlocks ?? 100n)) {
      await this.alerter.alert(
        "keeper-lag",
        `The keeper is ${minutes(lagMs)} behind the chain head (block ${scanned.number} of ${head.number}). New breaches aren't being claimed.`,
      );
    } else this.alerter.reset("keeper-lag");
  }

  private async checkStuckClaims() {
    const rows = (
      await this.db.pool.query(
        "SELECT id,vault,breach_id FROM handled_events WHERE chain_id=$1 AND status='pending' AND error IS NOT NULL ORDER BY id",
        [this.chain.deployment.chainId],
      )
    ).rows as { id: string; vault: string; breach_id: string }[];
    const now = this.now();
    const live = new Set(rows.map((r) => r.id));
    for (const id of this.erroringSince.keys()) if (!live.has(id)) this.erroringSince.delete(id);
    for (const r of rows) if (!this.erroringSince.has(r.id)) this.erroringSince.set(r.id, now);
    const stuckMs = this.options.stuckClaimMs ?? 10 * 60_000;
    const stuck = rows.filter((r) => now - this.erroringSince.get(r.id)! >= stuckMs);
    if (stuck.length === 0) return;
    const first = stuck[0]!;
    await this.alerter.alert(
      "stuck-claims",
      `${stuck.length} breach claim(s) have been failing for over ${minutes(stuckMs)}. The oldest: vault ${first.vault}, breach ${first.breach_id}. The keeper keeps retrying; anyone can also call fileClaim.`,
    );
  }

  private async checkFailureEvents() {
    // The first check starts from the newest event, so a restart doesn't replay old failures.
    if (this.lastEventId === undefined) {
      const r = await this.db.pool.query("SELECT coalesce(max(id),0)::text AS id FROM events");
      this.lastEventId = r.rows[0].id as string;
      return;
    }
    const rows = (
      await this.db.pool.query(
        "SELECT id::text,topic,payload FROM events WHERE id>$1 AND topic = ANY($2) ORDER BY id LIMIT 100",
        [this.lastEventId, Object.keys(FAILURE_TOPICS)],
      )
    ).rows as { id: string; topic: string; payload: Record<string, unknown> }[];
    for (const row of rows) {
      const kind = FAILURE_TOPICS[row.topic]!;
      const ids = kind.fields
        .filter((f) => row.payload?.[f] !== undefined)
        .map((f) => `${f} ${safeId(row.payload[f])}`)
        .join(", ");
      await this.alerter.alert(`event:${row.topic}`, `${kind.text}${ids ? ` (${ids})` : ""}.`);
      this.lastEventId = row.id;
    }
  }
}

/** Ids only: letters, digits, 0x, colons and dashes, at most 80 characters. */
function safeId(value: unknown): string {
  return String(value)
    .replace(/[^0-9A-Za-z:_-]/g, "")
    .slice(0, 80);
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m >= 120 ? `${Math.round(m / 60)} hours` : `${m} minutes`;
}
