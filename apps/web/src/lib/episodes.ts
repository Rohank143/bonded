import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api, type EpisodesQuery } from "./api";
import {
  NO_EPISODES,
  outcomeOf,
  useEpisodeFeed,
  type EpisodeCard,
  type EpisodeCounts,
} from "./events";

export type EpisodeFilters = Omit<EpisodesQuery, "before" | "limit">;

/** Whether a live episode belongs in a list with these filters (the API applies the same). */
export function matches(c: EpisodeCard, f: EpisodeFilters): boolean {
  return (
    (!f.runId || c.runId === f.runId) &&
    (!f.outcome || outcomeOf(c) === f.outcome) &&
    (!f.attackClass || c.attackClass === f.attackClass)
  );
}

/** Live and paged episodes as one list: newest first by event id, each once. */
export function mergeEpisodes(live: EpisodeCard[], paged: EpisodeCard[]): EpisodeCard[] {
  const seen = new Set<string>();
  const out: EpisodeCard[] = [];
  for (const c of [...live, ...paged])
    if (!seen.has(c.eventId)) {
      seen.add(c.eventId);
      out.push(c);
    }
  return out.sort((a, b) => (BigInt(b.eventId) > BigInt(a.eventId) ? 1 : -1));
}

export const addCounts = (a: EpisodeCounts, b: EpisodeCounts): EpisodeCounts => ({
  total: a.total + b.total,
  held: a.held + b.held,
  breach: a.breach + b.breach,
  control: a.control + b.control,
});

/**
 * The Arena's episodes: pages from GET /episodes (filtered in the database, newest first),
 * plus a live stream of new ones. One stream per run: it opens after the `through` of the
 * run's first page and doesn't restart when the filters change. Counts are the server's,
 * taken through that id, plus every episode streamed since, so they are exact.
 */
export function useEpisodes(filters: EpisodeFilters, limit = 30) {
  const pages = useInfiniteQuery({
    queryKey: ["episodes", filters, limit],
    queryFn: ({ pageParam }) =>
      api.episodes({ ...filters, limit, ...(pageParam ? { before: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const runId = filters.runId;
  const first = pages.data?.pages[0];
  const [base, setBase] = useState<{
    runId: string | undefined;
    through: string;
    counts: EpisodeCounts;
  }>();
  useEffect(() => {
    if (first?.through && first.counts && (!base || base.runId !== runId))
      setBase({ runId, through: first.through, counts: first.counts });
  }, [first, runId, base]);
  const current = base && base.runId === runId ? base : undefined;
  const feed = useEpisodeFeed(runId, current?.through);
  const items = useMemo(
    () =>
      mergeEpisodes(
        feed.cards.filter((c) => matches(c, filters)),
        pages.data?.pages.flatMap((p) => p.items) ?? [],
      ),
    // `filters` is a new object each render; compare it by value.
    [feed.cards, pages.data, JSON.stringify(filters)],
  );
  return {
    items,
    counts: current ? addCounts(current.counts, feed.added) : undefined,
    /** The newest episode streamed since the page opened, whatever the filters. */
    newest: feed.cards[0],
    connected: feed.connected,
    failedRuns: feed.failedRuns,
    isPending: pages.isPending,
    error: pages.error,
    hasMore: pages.hasNextPage,
    loadingMore: pages.isFetchingNextPage,
    loadMore: () => pages.fetchNextPage(),
  };
}

export { NO_EPISODES };
