import { ago } from "./format";
import type { ApiMessage } from "./troubleshooting";
import { ethText } from "./wallet-help";

/**
 * An agent's health at a glance (launch items 4.2, 4.3, 4.5, 6.1, 6.2 and 7.2), as the API's
 * health, vault-activity, notifications and status endpoints give it, and the lines the page
 * shows for each. Plain functions, so each state is testable.
 */

/** GET /self/agents/:id/vault-activity: trades through the vault (or module) from the agent key. */
export interface VaultActivity {
  firstTradeAt: string | null;
  lastTradeAt: string | null;
  trades24h: number;
  lastTxHash: string | null;
}

/** The agent key's gas: it pays for its own `execute` calls. Balance in wei, as a string. */
export interface AgentGas {
  address?: string | null;
  balance: string;
  low: boolean;
  /** Trades it can still pay for at recent gas use, when known. */
  estimatedTradesLeft?: number | null;
}

export type RunnerHealth = "connected" | "offline" | "never" | "url";
export type CoverHealth = "active" | "none" | "past-due" | "grace" | "lapsed";

/** A problem in a sentence, with what to do about it. */
export type HealthProblem = ApiMessage & { action?: string | null };

/** GET /self/agents/:id/health (session). */
export interface AgentHealth {
  score: { value: number; tier: string; expiresAt: string; valid: boolean } | null;
  runner: { status: RunnerHealth; lastSeenAt?: string | null };
  vault: VaultActivity | null;
  gas: AgentGas | null;
  cover: { status: CoverHealth; amount?: number | null; paidUntil?: string | null } | null;
  nextRatingAt: string | null;
  /** Active cover but no trade through the vault in the last 7 days (or ever). */
  coverWithoutVaultTrades?: boolean;
  problems: (string | { code?: string | null; message: string; action?: string | null })[];
}

export type Tone = "safe" | "warn" | "breach" | "neutral";

/** How the vault's trading reads. */
export function vaultTradingLine(
  a: VaultActivity | null | undefined,
  nowMs = Date.now(),
): { text: string; tone: Tone } {
  if (!a) return { text: "Not known yet.", tone: "neutral" };
  if (!a.lastTradeAt)
    return {
      text: "No trade through the vault yet. Until your agent trades through it, the mandate doesn't protect anything.",
      tone: "warn",
    };
  const recent = Date.parse(a.lastTradeAt) > nowMs - 7 * 86_400_000;
  const day = a.trades24h
    ? `${a.trades24h} trade${a.trades24h === 1 ? "" : "s"} in the last 24 hours`
    : "none in the last 24 hours";
  return {
    text: `Last trade through the vault ${ago(a.lastTradeAt, nowMs)}; ${day}.`,
    tone: recent ? "safe" : "warn",
  };
}

export const COVER_WITHOUT_TRADES =
  "This agent has cover, but it hasn't traded through its vault in the last 7 days. Cover pays only for what goes through the vault: if your agent trades from another wallet, those trades aren't covered.";

/** The low-gas notice, or undefined when there's enough. */
export function gasNotice(gas: AgentGas | null | undefined): string | undefined {
  if (!gas?.low) return undefined;
  let balance: string;
  try {
    balance = ethText(BigInt(gas.balance));
  } catch {
    balance = gas.balance;
  }
  const left =
    gas.estimatedTradesLeft != null
      ? ` That's enough for about ${gas.estimatedTradesLeft} more trade${gas.estimatedTradesLeft === 1 ? "" : "s"}.`
      : "";
  return `Your agent's key is low on gas: it has ${balance}, and it pays the gas for every trade through the vault.${left}`;
}

export const RUNNER_TEXT: Record<RunnerHealth, { label: string; tone: Tone }> = {
  connected: { label: "Runner connected", tone: "safe" },
  offline: { label: "Runner offline", tone: "warn" },
  never: { label: "Runner never connected", tone: "neutral" },
  url: { label: "Agent URL", tone: "safe" },
};

export const COVER_TEXT: Record<CoverHealth, { label: string; tone: Tone }> = {
  active: { label: "Cover active", tone: "safe" },
  none: { label: "No cover", tone: "neutral" },
  "past-due": { label: "Premium past due", tone: "warn" },
  grace: { label: "Cover in grace period", tone: "warn" },
  lapsed: { label: "Cover lapsed", tone: "breach" },
};

/** The score's line: valid until when, expiring soon, or expired. */
export function scoreLine(
  s: AgentHealth["score"],
  nowMs = Date.now(),
): { text: string; tone: Tone } {
  if (!s) return { text: "Not rated yet", tone: "neutral" };
  const left = Date.parse(s.expiresAt) - nowMs;
  if (!s.valid || left <= 0) return { text: `Score ${s.value} expired`, tone: "breach" };
  const days = Math.floor(left / 86_400_000);
  if (days < 7)
    return {
      text: `Score ${s.value} (${s.tier}) expires in ${days === 0 ? "less than a day" : `${days} day${days === 1 ? "" : "s"}`}`,
      tone: "warn",
    };
  return { text: `Score ${s.value} (${s.tier}), valid for ${days} more days`, tone: "safe" };
}

/** GET /self/notifications/inbox (session): the owner's in-app notifications, newest first. */
export interface InboxItem {
  id: string;
  /** e.g. score-expiring, runner-offline, breach, claim-filed, claim-paid, cover-lapsing, low-gas. */
  kind: string;
  code?: string | null;
  message: string;
  createdAt: string;
  agentId?: string | null;
  read?: boolean;
}

const SEEN_KEY = "bonded:inbox-seen";

/** When this browser last opened the inbox: what's newer counts as unread. */
export function inboxSeenAt(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

export function markInboxSeen(nowMs = Date.now()) {
  try {
    localStorage.setItem(SEEN_KEY, String(nowMs));
  } catch {
    // Storage off: everything stays unread, which is harmless.
  }
}

/** Unread items: the API's own `read` when it gives one, else newer than the last visit. */
export function unreadCount(items: InboxItem[], seenAt = inboxSeenAt()): number {
  return items.filter((i) => (i.read !== undefined ? !i.read : Date.parse(i.createdAt) > seenAt))
    .length;
}

/** GET /status (public, cached). */
export interface ServiceStatus {
  gateway: { up: boolean };
  lanes: {
    check: { healthy: boolean; lastJobAgeSeconds: number | null };
    remote: { healthy: boolean; lastJobAgeSeconds: number | null };
  };
  previewQueue: number;
  version: string | null;
  checkedAt: string;
}

/** The overall state, for the small indicator. */
export function overallStatus(
  s: ServiceStatus | undefined,
  failed: boolean,
): {
  label: string;
  tone: Tone;
} {
  if (failed) return { label: "Status unknown", tone: "neutral" };
  if (!s) return { label: "Checking status", tone: "neutral" };
  if (!s.gateway.up) return { label: "Ratings are down", tone: "breach" };
  if (!s.lanes.check.healthy || !s.lanes.remote.healthy)
    return { label: "Ratings are slow", tone: "warn" };
  return { label: "All systems normal", tone: "safe" };
}

/** "3 min ago", "never": how long since a lane last finished a job. */
export function jobAge(seconds: number | null): string {
  if (seconds === null) return "no job yet";
  if (seconds < 90) return "under 2 min ago";
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}
