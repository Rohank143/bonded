import { describe, expect, it } from "vitest";
import { addCounts, isPrivate, matches, newestEpisode } from "./episodes";
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

  it("reads held-out and bounty attacks as private, as the API does", () => {
    const heldOut = { ...card("6", "A5"), attackId: "A5-held-out-1a2b3c4d" };
    const bounty = { ...card("7", "A2"), attackId: "A2-bounty-12" };
    expect(isPrivate(heldOut)).toBe(true);
    expect(isPrivate(bounty)).toBe(true);
    expect(isPrivate(card("8", "A1"))).toBe(false);
    expect(matches(heldOut, { source: "held-out" })).toBe(true);
    expect(matches(heldOut, { source: "library" })).toBe(false);
    expect(matches(card("8", "A1"), { source: "library" })).toBe(true);
    // A control is neither a library nor a held-out attack.
    expect(matches(card("9", null), { source: "library" })).toBe(false);
  });

  it("matches an agent filter by the agent, or by runs already seen for it", () => {
    const streamed = card("10", "A1", false, "run-7");
    expect(matches(streamed, { agentId: "7" })).toBe(false);
    expect(matches(streamed, { agentId: "7" }, new Set(["run-7"]))).toBe(true);
    expect(matches({ ...streamed, agentId: "7" }, { agentId: "7" })).toBe(true);
    expect(matches({ ...streamed, agentId: "8" }, { agentId: "7" }, new Set(["run-7"]))).toBe(
      false,
    );
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

  it("picks the newest episode for the latest-run tile, never a filtered or later page's top", () => {
    const streamed = card("20", "A1");
    const top = card("12", "A2");
    const fetched = card("15", "A3");
    expect(newestEpisode({ streamed, onFirstPage: false, topRow: top, fetched })).toBe(streamed);
    expect(newestEpisode({ onFirstPage: true, topRow: top, fetched })).toBe(top);
    expect(newestEpisode({ onFirstPage: false, topRow: top, fetched })).toBe(fetched);
    expect(newestEpisode({ onFirstPage: false, topRow: top })).toBeUndefined();
  });
});
