import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, type EpisodeFilters } from "./api";
import {
  NO_EPISODES,
  outcomeOf,
  tally,
  useEpisodeFeed,
  type EpisodeCard,
  type EpisodeCounts,
} from "./events";

export type { EpisodeFilters };

/** Held-out and bounty attacks have ids that say so; the API reads them the same way. */
export const isPrivate = (c: EpisodeCard) =>
  Boolean(c.attackId && /held-out|bounty/i.test(c.attackId));

/**
 * Whether a streamed episode belongs in a list with these filters, as the API decides it. The
 * stream doesn't say which agent a run rates, so for an agent filter `agentRuns` lists the runs
 * already seen for that agent. A new episode is always inside a "since" window.
 */
export function matches(
  c: EpisodeCard,
  f: EpisodeFilters,
  agentRuns: ReadonlySet<string> = new Set(),
): boolean {
  return (
    (!f.runId || c.runId === f.runId) &&
    (!f.agentId || (c.agentId != null ? c.agentId === f.agentId : agentRuns.has(c.runId))) &&
    (!f.outcome || outcomeOf(c) === f.outcome) &&
    (!f.attackClass || c.attackClass === f.attackClass) &&
    (!f.source ||
      (f.source === "held-out" ? isPrivate(c) : Boolean(c.attackClass) && !isPrivate(c)))
  );
}

/**
 * The newest episode overall, for the Arena's "latest run" tile: one streamed since the list
 * loaded, else the top row when the list is the unfiltered first page, else one fetched on its
 * own. Never a filtered or later page's top row, which isn't the newest.
 */
export function newestEpisode(o: {
  streamed?: EpisodeCard;
  onFirstPage: boolean;
  topRow?: EpisodeCard;
  fetched?: EpisodeCard;
}): EpisodeCard | undefined {
  return o.streamed ?? (o.onFirstPage ? o.topRow : o.fetched);
}

export const addCounts = (a: EpisodeCounts, b: EpisodeCounts): EpisodeCounts => ({
  total: a.total + b.total,
  held: a.held + b.held,
  breach: a.breach + b.breach,
  control: a.control + b.control,
});

/**
 * The Arena's episodes as numbered pages of a snapshot. The first request takes the snapshot
 * (the API returns `through`, the newest event id); every later page and filter change reads
 * the same snapshot, so page 3 keeps its rows while episodes arrive. A live stream after
 * `through` counts the new ones: `fresh` is how many would join this list, and the counts
 * include every new episode the filters allow. `refresh` takes a new snapshot.
 */
export function useEpisodeSnapshot(filters: EpisodeFilters, page: number, limit: number) {
  const [snapshot, setSnapshot] = useState(0);
  const through = useRef<string | undefined>(undefined);
  const [streamFrom, setStreamFrom] = useState<string>();
  const list = useQuery({
    queryKey: ["episodes", filters, page, limit, snapshot],
    queryFn: () =>
      api.episodes({
        ...filters,
        page,
        limit,
        ...(through.current ? { through: through.current } : {}),
      }),
    placeholderData: keepPreviousData,
  });
  useEffect(() => {
    if (list.data && !through.current) {
      through.current = list.data.through;
      setStreamFrom(list.data.through);
    }
  }, [list.data]);
  const feed = useEpisodeFeed(filters.runId, streamFrom);

  const agentRuns = new Set(
    (list.data?.items ?? []).filter((c) => c.agentId === filters.agentId).map((c) => c.runId),
  );
  // The counts cover every outcome, so new episodes count whatever the outcome filter says.
  const scope: EpisodeFilters = { ...filters };
  delete scope.outcome;
  const fresh = feed.cards.filter((c) => matches(c, filters, agentRuns)).length;
  const streamed = feed.cards
    .filter((c) => matches(c, scope, agentRuns))
    .reduce(tally, NO_EPISODES);
  return {
    data: list.data,
    counts: list.data ? addCounts(list.data.counts, streamed) : undefined,
    fresh,
    newest: feed.cards[0],
    connected: feed.connected,
    failedRuns: feed.failedRuns,
    isPending: list.isPending,
    isFetching: list.isFetching,
    error: list.error,
    refresh: () => {
      through.current = undefined;
      setStreamFrom(undefined);
      setSnapshot((s) => s + 1);
    },
  };
}
