import { expect, it } from "vitest";
import { addCard, toEpisodeCard } from "./events";

const episode = (breached: boolean) =>
  JSON.stringify({
    runId: "4826cbb6-7aea-4b96-b1d4-43100a2b7ce0",
    index: 3,
    total: 42,
    episode: {
      attackId: "a1-metadata-01",
      attackClass: "A1",
      verdict: { breached, totalLossUsd: breached ? 1000 : 0, frozen: breached },
    },
  });

it("turns a rating.episode payload into a card", () => {
  expect(toEpisodeCard("7", episode(true))).toEqual({
    eventId: "7",
    runId: "4826cbb6-7aea-4b96-b1d4-43100a2b7ce0",
    index: 3,
    total: 42,
    attackId: "a1-metadata-01",
    attackClass: "A1",
    breached: true,
    lossUsd: 1000,
    frozen: true,
    ruling: null,
    // No start time in this older payload: it counts as having arrived now.
    at: expect.any(String),
  });
});

it("carries the vault's ruling when the episode has one", () => {
  const data = JSON.stringify({
    runId: "r",
    index: 0,
    total: 1,
    episode: {
      attackId: "A6-x",
      attackClass: "A6",
      verdict: { breached: false },
      ruling: "unseen",
    },
  });
  expect(toEpisodeCard("1", data)?.ruling).toBe("unseen");
});

it("treats a control episode (no attack) as a card too", () => {
  const data = JSON.stringify({
    runId: "r",
    index: 0,
    total: 2,
    episode: { attackId: null, attackClass: null, verdict: { breached: false } },
  });
  expect(toEpisodeCard("1", data)).toMatchObject({
    attackClass: null,
    breached: false,
    lossUsd: 0,
  });
});

it("ignores malformed events instead of breaking the feed", () => {
  for (const bad of [
    "not json",
    "{}",
    JSON.stringify({ runId: "r", index: 1 }),
    JSON.stringify({ runId: 5, index: 1, episode: { verdict: {} } }),
  ])
    expect(toEpisodeCard("1", bad)).toBeNull();
});

it("keeps newest first, drops replayed duplicates and caps the list", () => {
  const card = (id: string) => toEpisodeCard(id, episode(false))!;
  let cards = addCard([], card("1"));
  cards = addCard(cards, card("2"));
  expect(cards.map((c) => c.eventId)).toEqual(["2", "1"]);
  expect(addCard(cards, card("2"))).toBe(cards);
  expect(addCard(cards, card("3"), 2).map((c) => c.eventId)).toEqual(["3", "2"]);
});

it("reads whether the attack is published from the episode's detail", () => {
  const data = (published: unknown) =>
    JSON.stringify({
      runId: "r",
      index: 0,
      total: 1,
      episode: {
        attackId: "A6-x",
        attackClass: "A6",
        verdict: { breached: false },
        detail: { attack: { published } },
      },
    });
  expect(toEpisodeCard("1", data(false))?.published).toBe(false);
  expect(toEpisodeCard("1", data(true))?.published).toBe(true);
  expect(toEpisodeCard("1", data("yes"))).not.toHaveProperty("published");
});

it("carries when the episode started", () => {
  const data = JSON.stringify({
    runId: "r",
    index: 0,
    total: 1,
    episode: {
      attackId: null,
      attackClass: null,
      startedAt: "2026-10-07T14:58:12.000Z",
      verdict: { breached: false },
    },
  });
  expect(toEpisodeCard("1", data)?.at).toBe("2026-10-07T14:58:12.000Z");
});
