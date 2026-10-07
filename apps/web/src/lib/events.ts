import { useEffect, useState } from "react";
import { apiUrl } from "../config";

/** One attack or control episode as streamed by the Arena worker (topic `rating.episode`). */
export interface EpisodeCard {
  eventId: string;
  runId: string;
  index: number;
  total: number;
  attackId: string | null;
  attackClass: string | null;
  /** The vault recorded a breach: the agent broke its mandate. */
  breached: boolean;
  lossUsd: number;
  frozen: boolean;
  /** The rated agent's on-chain id; from GET /episodes only, the live stream doesn't carry it. */
  agentId?: string | null;
}

/** Topics the API streams (docs/SERVICES.md). Unknown topics are ignored. */
export const FEED_TOPICS = ["rating.episode", "rating.failed", "claim.paid"] as const;

/**
 * Turn one `rating.episode` payload into a card. Returns null for anything malformed, so a bad
 * or unexpected event can never break the feed.
 */
export function toEpisodeCard(eventId: string, data: string): EpisodeCard | null {
  try {
    const p = JSON.parse(data) as {
      runId?: unknown;
      index?: unknown;
      total?: unknown;
      episode?: {
        attackId?: string | null;
        attackClass?: string | null;
        verdict?: { breached?: boolean; totalLossUsd?: number; frozen?: boolean };
      };
    };
    if (typeof p.runId !== "string" || typeof p.index !== "number" || !p.episode?.verdict)
      return null;
    return {
      eventId,
      runId: p.runId,
      index: p.index,
      total: typeof p.total === "number" ? p.total : 0,
      attackId: p.episode.attackId ?? null,
      attackClass: p.episode.attackClass ?? null,
      breached: p.episode.verdict.breached === true,
      lossUsd: Number(p.episode.verdict.totalLossUsd ?? 0),
      frozen: p.episode.verdict.frozen === true,
    };
  } catch {
    return null;
  }
}

/** Newest first, no duplicates (the API may replay after a reconnect), at most `limit` cards. */
export function addCard(cards: EpisodeCard[], card: EpisodeCard, limit = 200): EpisodeCard[] {
  if (cards.some((c) => c.eventId === card.eventId)) return cards;
  return [card, ...cards].slice(0, limit);
}

/** Episode counts by outcome, as GET /episodes returns them. */
export interface EpisodeCounts {
  total: number;
  held: number;
  breach: number;
  control: number;
}

/** How an episode went: a control has no attack; otherwise the vault held or recorded a breach. */
export type Outcome = "held" | "breach" | "control";
export const outcomeOf = (c: EpisodeCard): Outcome =>
  !c.attackClass ? "control" : c.breached ? "breach" : "held";

/** Add one episode to a tally. */
export function tally(counts: EpisodeCounts, card: EpisodeCard): EpisodeCounts {
  const o = outcomeOf(card);
  return { ...counts, total: counts.total + 1, [o]: counts[o] + 1 };
}

export const NO_EPISODES: EpisodeCounts = { total: 0, held: 0, breach: 0, control: 0 };

/**
 * Subscribe to new episodes after event `after` (the `through` of GET /episodes), so nothing
 * older is replayed. EventSource reconnects on its own and sends Last-Event-ID, so the API
 * resumes where the stream left off. `cards` keeps the newest 500. Nothing starts until
 * `after` is known.
 */
export function useEpisodeFeed(runId: string | undefined, after: string | undefined) {
  const [cards, setCards] = useState<EpisodeCard[]>([]);
  const [connected, setConnected] = useState(false);
  const [failedRuns, setFailedRuns] = useState<string[]>([]);
  useEffect(() => {
    setCards([]);
    if (after === undefined) return;
    const url = new URL(`${apiUrl}/events`);
    url.searchParams.set("after", after);
    if (runId) url.searchParams.set("runId", runId);
    const source = new EventSource(url);
    let last = BigInt(after);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener("rating.episode", (e) => {
      const card = toEpisodeCard(e.lastEventId, e.data);
      // Ids arrive in order; anything at or below the last one is a replay already counted.
      if (!card || BigInt(card.eventId) <= last) return;
      last = BigInt(card.eventId);
      setCards((c) => addCard(c, card, 500));
    });
    source.addEventListener("rating.failed", (e) => {
      try {
        const { runId: failed } = JSON.parse(e.data) as { runId?: string };
        if (failed) setFailedRuns((f) => (f.includes(failed) ? f : [...f, failed]));
      } catch {
        // Ignore a malformed event.
      }
    });
    return () => source.close();
  }, [runId, after]);
  return { cards, connected, failedRuns };
}
