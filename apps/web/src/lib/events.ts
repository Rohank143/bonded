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

/**
 * Subscribe to the API's server-sent events. EventSource reconnects on its own and sends
 * Last-Event-ID, so the API replays what was missed.
 */
export function useEpisodeFeed(runId?: string) {
  const [cards, setCards] = useState<EpisodeCard[]>([]);
  const [connected, setConnected] = useState(false);
  const [failedRuns, setFailedRuns] = useState<string[]>([]);
  useEffect(() => {
    setCards([]);
    const url = new URL(`${apiUrl}/events`);
    if (runId) url.searchParams.set("runId", runId);
    const source = new EventSource(url);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener("rating.episode", (e) => {
      const card = toEpisodeCard(e.lastEventId, e.data);
      if (card) setCards((c) => addCard(c, card));
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
  }, [runId]);
  return { cards, connected, failedRuns };
}
