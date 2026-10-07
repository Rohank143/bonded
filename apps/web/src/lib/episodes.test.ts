import { describe, expect, it } from "vitest";
import { addCounts, matches, mergeEpisodes } from "./episodes";
import { NO_EPISODES, outcomeOf, tally, type EpisodeCard } from "./events";

const card = (eventId: string, attackClass: string | null, breached = false, runId = "r1") =>
  ({
    eventId,
    runId,
    index: 0,
    total: 1,
    attackId: attackClass ? `${attackClass}-x` : null,
    attackClass,
    breached,
    lossUsd: 0,
    frozen: false,
  }) satisfies EpisodeCard;

describe("episodes", () => {
  it("reads an episode's outcome the way the API filters it", () => {
    expect(outcomeOf(card("1", null))).toBe("control");
    expect(outcomeOf(card("2", "A1", true))).toBe("breach");
    expect(outcomeOf(card("3", "A1"))).toBe("held");
  });

  it("matches live episodes against the list's filters", () => {
    const c = card("5", "A3", true, "r2");
    expect(matches(c, {})).toBe(true);
    expect(matches(c, { runId: "r2", outcome: "breach", attackClass: "A3" })).toBe(true);
    expect(matches(c, { runId: "r1" })).toBe(false);
    expect(matches(c, { outcome: "held" })).toBe(false);
    expect(matches(c, { attackClass: "A1" })).toBe(false);
  });

  it("merges live and paged episodes newest first, each once", () => {
    const live = [card("12", "A1"), card("10", "A2")];
    const paged = [card("10", "A2"), card("9", null), card("3", "A1")];
    expect(mergeEpisodes(live, paged).map((c) => c.eventId)).toEqual(["12", "10", "9", "3"]);
    // Ids compare as numbers, not strings.
    expect(mergeEpisodes([card("100", null)], [card("99", null)]).map((c) => c.eventId)).toEqual([
      "100",
      "99",
    ]);
  });

  it("adds streamed episodes to the server's counts", () => {
    const streamed = [card("1", null), card("2", "A1", true), card("3", "A2")].reduce(
      tally,
      NO_EPISODES,
    );
    expect(streamed).toEqual({ total: 3, held: 1, breach: 1, control: 1 });
    expect(addCounts({ total: 10, held: 7, breach: 2, control: 1 }, streamed)).toEqual({
      total: 13,
      held: 8,
      breach: 3,
      control: 2,
    });
  });
});
