import type { AttackSpec, SelfServeKind } from "@bonded/shared";
import { apiUrl } from "../config";
import type { EpisodeCard, EpisodeCounts, Outcome } from "./events";

/** Error from the Bonded API, carrying its HTTP status and the API's error message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, init);
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof body === "object" && body && "error" in body
        ? String(body.error)
        : response.statusText;
    throw new ApiError(response.status, message || `request failed (${response.status})`);
  }
  return body as T;
}

/** One numbered page of a list: `page` is 1-based, `pages` is at least 1. */
export interface Paged<T> {
  items: T[];
  page: number;
  pages: number;
  total: number;
}

/** GET /episodes: a page of a snapshot taken through event `through`, and its counts. */
export interface EpisodesPage extends Paged<EpisodeCard> {
  through: string;
  /** By outcome, with every filter but the outcome. */
  counts: EpisodeCounts;
}

/**
 * What an episode's page shows (`EpisodeDetail` in apps/arena/src/report.ts). For a held-out or
 * bounty attack, `attack.planted`, guard reasons and `finalMessage` are never sent.
 */
export interface EpisodeDetail {
  task: string;
  attack: {
    published: boolean;
    title?: string;
    surfaces: string[];
    planted?: {
      surface: string;
      sender?: string;
      token?: string;
      prices?: Record<string, number>;
      text: string;
    }[];
  } | null;
  seen: boolean | null;
  steps: {
    step: number;
    tool: string;
    write: boolean;
    args?: Record<string, string>;
    ok: boolean;
    breaches: { type: string; lossUsd: number; blocked: boolean }[];
  }[];
  guardBlocked: { tool: string; args?: Record<string, string>; reason?: string }[];
  drained: { token: string; amount: string }[];
  stoppedBecause: string;
  finalMessage?: string;
}

/** GET /episodes/:eventId. `detail` is null for episodes from before it was recorded. */
export interface EpisodeRecord extends EpisodeCard {
  agent: string | null;
  durationMs: number | null;
  detail: EpisodeDetail | null;
}

export interface EpisodeFilters {
  runId?: string;
  /** One attack's episodes, by its id. */
  attackId?: string;
  agentId?: string;
  outcome?: Outcome;
  attackClass?: string;
  source?: "held-out" | "library";
  since?: "1h" | "24h" | "7d";
}

export interface EpisodesQuery extends EpisodeFilters {
  through?: string;
  page?: number;
  limit?: number;
}

/** An attack's record in the Arena episodes still on record. */
export interface AttackStats {
  episodes: number;
  breaches: number;
  runs: number;
  lastAt: string | null;
}

/** A published attack in the red team list (no planted text). */
export interface AttackSummary {
  id: string;
  class: string;
  title: string;
  description: string;
  surfaces: string[];
  severity: "low" | "medium" | "high" | "critical";
  tags: string[];
  stats: AttackStats;
}

export interface AttacksPage extends Paged<AttackSummary> {
  /** When the oldest episode on record ran: the stats cover episodes since then. */
  statsSince: string | null;
}

export interface AttacksQuery {
  attackClass?: string;
  surface?: string;
  severity?: string;
  sort?: "class" | "breaches" | "rate";
  page?: number;
  limit?: number;
}

/** GET /library. */
export interface LibraryCounts {
  published: number;
  acceptedBounties: number;
  heldOut: { active: number; retiresFrom: string | null };
}

export interface BountiesQuery {
  status?: "validating" | "accepted" | "rejected" | "failed";
  attackClass?: string;
  hunter?: string;
  sort?: "newest" | "reward";
  page?: number;
  limit?: number;
}

/** A query string from the defined values only. */
function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

/**
 * POST endpoints need the operator token (docs/SERVICES.md). The page keeps it in memory only:
 * it is never written to storage or a URL.
 */
function post<T>(path: string, token: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export interface ScoreRecord {
  runId: string;
  tx_hash: string;
  signed: { attestation: { reportHash: string; issuedAt: number; expiresAt: number } };
}
/** The keeper's latest live check of a TEE-hosted agent (docs/TEE.md, "Live checks"). */
export interface TeeCheckRecord {
  status: "verified" | "unrated" | "mismatch" | "invalid" | "unreachable";
  /** A definite failure still outstanding. It survives an offline agent (ADR-013). */
  blockingStatus: "mismatch" | "invalid" | null;
  detail: string | null;
  measurement: string | null;
  evmAddress: string | null;
  checkedAt: string;
  verifiedAt: string | null;
}
export interface RunRecord {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  error: string | null;
  created_at: string;
  report: Report | null;
}
export interface Report {
  agent: string;
  modelFamily: string;
  mandateMode: string;
  forked: boolean;
  startedAt: string;
  durationMs: number;
  scoring: { score: number; tier: string };
  episodes: { total: number; attacks: number; controls: number; agentErrors: number };
  controls: { episodes: number; breaches: number };
  /** Accepted bounties and held-out attacks in the rating; older reports don't have it. */
  unpublished?: { attacks: number; episodes: number };
  /** Set when the agent proved it runs in a TEE; reports from before Day 11 don't have it. */
  tee?: {
    measurement: `0x${string}`;
    composeHash: `0x${string}`;
    evmAddress: string;
    solanaPublicKey: string;
    tcbStatus: string;
  } | null;
  classes: {
    class: string;
    name: string;
    episodes: number;
    breaches: number;
    attackSucceeded: number;
    agentErrors: number;
    lossUsd: number;
  }[];
}
export interface SignedQuoteResponse {
  quote: {
    agentId: string;
    vault: `0x${string}`;
    coverAmount: string;
    premiumRateBps: number;
    score: number;
    modelFamily: string;
    [key: string]: unknown;
  };
  signature: `0x${string}`;
}

/** One leaderboard entry (config/leaderboard.json): class-level results only. */
export interface LeaderboardRecord {
  slug: string;
  name: string;
  kind: "framework" | "reference";
  framework: string;
  template?: string;
  model: string | null;
  ratedAt: string;
  score: number;
  tier: string;
  expectedLossBps: number;
  premiumRateBps: number;
  insurable: boolean;
  episodes: { attacks: number; controls: number; controlBreaches: number };
  classes: { class: string; name: string; episodes: number; breaches: number }[];
  reportHash: string;
  onchain: { chain: string; agentId: string; tx: string | null } | null;
  disclosure: {
    status: "not-needed" | "pending" | "notified" | "published";
    notifiedAt?: string;
    note?: string;
  };
  /** The registry still holds this rating's score (null: not posted on this chain). */
  verified: boolean | null;
}

/** An agent's self-serve registration, as GET /self/agents/:id reports it. */
export type SelfAgentRecord =
  | { registered: false }
  | {
      registered: true;
      source: "operator" | "user";
      kind: string;
      owner: string | null;
      lastRatingAt: string | null;
      nextRatingAt: string | null;
    };

/** A community bounty as the API lists it: no payload, which stays private. */
export interface BountyRecord {
  submissionId: string;
  hunter: string;
  specUri: string;
  attackId: string;
  attackClass: string;
  title: string;
  surfaces: string[];
  status: "validating" | "accepted" | "rejected" | "failed";
  /** tUSDG base units. */
  reward: string | null;
  reason: string | null;
  txHash: string | null;
  createdAt: string;
}

export const api = {
  health: () => request<{ ok: boolean; chainId: number }>("/health"),
  leaderboard: () =>
    request<{
      headline: {
        templates: number;
        failingTemplates: number;
        evaluations: number;
        failingEvaluations: number;
      };
      entries: LeaderboardRecord[];
    }>("/leaderboard"),
  score: (agentId: string) => request<ScoreRecord>(`/agents/${agentId}/score`),
  tee: (agentId: string) => request<TeeCheckRecord>(`/agents/${agentId}/tee`),
  run: (runId: string) => request<RunRecord>(`/arena/runs/${runId}`),
  startRun: (token: string, agentId: string) =>
    post<{ runId: string }>("/arena/runs", token, { agentId }),
  /** No operator token needed; without one the API caps cover at 20,000 tUSDG (testnet). */
  quote: (input: { agentId: string; vault: string; coverAmount: string }) =>
    request<SignedQuoteResponse>("/quotes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  /** Whether an agent is registered for self-serve ratings (docs/AGENTS.md). */
  selfAgent: (agentId: string) => request<SelfAgentRecord>(`/self/agents/${agentId}`),
  /** Register an agent for ratings; the owner's wallet signed the request. */
  registerSelfAgent: (input: {
    agentId: string;
    vault: string;
    kind: SelfServeKind;
    mandate: unknown;
    timestamp: number;
    signature: string;
  }) =>
    request<{ registered: boolean }>("/self/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  /** Ask for a rating of a self-serve agent; the owner's wallet signed the request. */
  rateSelfAgent: (agentId: string, input: { timestamp: number; signature: string }) =>
    request<{ runId: string }>(`/self/agents/${agentId}/rate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  bounties: ({ attackClass, ...q }: BountiesQuery = {}) =>
    request<Paged<BountyRecord>>(`/bounties${query({ ...q, class: attackClass })}`),
  /** Arena episodes, newest first, as numbered pages of a snapshot, filtered in the database. */
  episodes: ({ attackClass, attackId, ...q }: EpisodesQuery = {}) =>
    request<EpisodesPage>(`/episodes${query({ ...q, class: attackClass, attack: attackId })}`),
  /** What ratings run, as counts: published, accepted bounties and the held-out set. */
  library: () => request<LibraryCounts>("/library"),
  /** The published attacks, a numbered page, each with its record in the Arena. */
  attacks: ({ attackClass, ...q }: AttacksQuery = {}) =>
    request<AttacksPage>(`/library/attacks${query({ ...q, class: attackClass })}`),
  /** One published attack in full, planted text included. */
  attack: (id: string) =>
    request<{ attack: AttackSpec; stats: AttackStats; statsSince: string | null }>(
      `/library/attacks/${encodeURIComponent(id)}`,
    ),
  /** One episode with its detail, for its page. */
  episode: (eventId: string) => request<EpisodeRecord>(`/episodes/${eventId}`),
  /** No operator token: the API checks the spec's hash against the revealed specURI. */
  revealBounty: (id: string, yaml: string) =>
    request<{ created: boolean; status: string }>(`/bounties/${id}/reveal`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: yaml,
    }),
};
