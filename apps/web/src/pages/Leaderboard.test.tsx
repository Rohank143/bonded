import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { ATTACK_LIBRARY_VERSION } from "@bondedhq/shared";
import { api, type LeaderboardRecord } from "../lib/api";
import { Leaderboard } from "./Leaderboard";

const entry = (name: string, score: number, securityGrade?: number): LeaderboardRecord => ({
  slug: name,
  name,
  kind: "reference",
  framework: "scripted",
  model: null,
  ratedAt: "2026-10-01T12:00:00Z",
  ...(securityGrade === undefined ? {} : { securityGrade }),
  score,
  tier: "AA",
  expectedLossBps: 100,
  premiumRateBps: 200,
  insurable: true,
  episodes: { attacks: 5, controls: 1, controlBreaches: 0 },
  classes: [],
  reportHash: "0xabc",
  onchain: null,
  disclosure: { status: "not-needed" },
  verified: null,
});

const NO_HEADLINE = { templates: 0, failingTemplates: 0, evaluations: 0, failingEvaluations: 0 };

async function renderBoard(entries: LeaderboardRecord[], headline = NO_HEADLINE) {
  vi.spyOn(api, "leaderboard").mockResolvedValue({ headline, entries });
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <Leaderboard />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  const rows = within(await screen.findByRole("list", { name: "Security rankings" })).getAllByRole(
    "listitem",
  );
  return (name: string) => rows.find((r) => r.textContent?.includes(name))!;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("leaderboard rankings", () => {
  it("ranks security grades, including zero, and leaves legacy insurance results unranked", async () => {
    vi.spyOn(api, "leaderboard").mockResolvedValue({
      headline: NO_HEADLINE,
      entries: [entry("Legacy", 100), entry("Weak", 99, 0), entry("Strong", 40, 90)],
    });
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <Leaderboard />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await screen.findByText("Strong");
    const rows = within(screen.getByRole("list", { name: "Security rankings" })).getAllByRole(
      "listitem",
    );
    expect(
      rows.map((row) =>
        ["Strong", "Weak", "Legacy"].find((name) => row.textContent?.includes(name)),
      ),
    ).toEqual(["Strong", "Weak", "Legacy"]);
    expect(within(rows[0]!).getByText("01")).toBeTruthy();
    expect(within(rows[0]!).getByText("90")).toBeTruthy();
    expect(within(rows[1]!).getByText("0")).toBeTruthy();
    expect(within(rows[2]!).getByText("—")).toBeTruthy();
    expect(within(rows[2]!).getByText("Not measured")).toBeTruthy();
    // The legacy note only shows when a legacy result is on the board.
    expect(screen.getByText(/predate the security grade and are unranked/)).toBeTruthy();
  });

  it("leaves out the legacy note and the podium when there's nothing to explain", async () => {
    await renderBoard([entry("A", 50, 90), entry("B", 50, 80), entry("C", 50, 70)]);
    expect(screen.queryByText(/predate the security grade/)).toBeNull();
    expect(screen.queryByText("#1")).toBeNull();
    // No headline stats; the scoring docs open in a new tab.
    expect(screen.queryByRole("region", { name: "Headline" })).toBeNull();
    const docs = screen.getByRole("link", { name: "How scoring works" });
    expect(docs.getAttribute("target")).toBe("_blank");
    expect(docs.getAttribute("rel")).toBe("noreferrer");
  });

  it("colours each class square by its worst graded track and names the weakest", async () => {
    const row = await renderBoard([
      {
        ...entry("Graded", 81, 25),
        worstClass: "A8",
        worstTrack: "s1",
        classes: [
          { class: "A2", name: "Injection via content", episodes: 10, manipulated: 3, breaches: 1 },
        ],
        s1Classes: [
          {
            class: "A8",
            counted: 12,
            manipulated: 9,
            inducedInaction: 2,
            breaches: 4,
            graded: true,
          },
          {
            class: "A2",
            counted: 8,
            manipulated: 1,
            inducedInaction: 0,
            breaches: 0,
            graded: true,
          },
          // Too few pairs to grade: listed, but it doesn't colour the square.
          {
            class: "A1",
            counted: 4,
            manipulated: 4,
            inducedInaction: 0,
            breaches: 0,
            graded: false,
          },
        ],
        memoryClasses: [{ class: "A2", counted: 5, manipulated: 1, graded: true }],
      },
    ]);
    const r = row("Graded");
    expect(within(r).getByText("A8 · market data")).toBeTruthy();
    // A8 only ran on market data (9 of 12, solid); A2 is worse on the main library (3 of 10)
    // than on market data (1 of 8) or memory (1 of 5); A1 is ungraded; A5 never ran.
    expect(within(r).getByRole("img", { name: "A8" }).className).toContain("bg-breach-solid");
    expect(within(r).getByRole("img", { name: "A2" }).className).toContain("bg-breach/45");
    expect(within(r).getByRole("img", { name: "A1" }).className).not.toContain("breach");
    expect(within(r).queryByRole("img", { name: "A5" })).toBeNull();
    // The tooltip lists each track on its own line.
    fireEvent.focus(within(r).getByRole("img", { name: "A2" }).parentElement!);
    const tip = (await screen.findByRole("tooltip")).textContent;
    expect(tip).toContain("Main library: manipulated in 3 of 10 episodes, 1 breached");
    expect(tip).toContain("Market data: false data moved it to act in 1 of 8 pairs");
    expect(tip).toContain("Memory: acted on a planted note in 1 of 5 attempts");
  });

  it("links the row to the agent's page and shows the model, source and chain status", async () => {
    const row = await renderBoard([
      {
        ...entry("AgentKit chatbot", 83, 33),
        kind: "framework",
        framework: "Coinbase AgentKit",
        model: "deepseek/deepseek-v4.1-flash",
        template: "https://example.com/agentkit",
        disclosure: { status: "pending" },
        onchain: { chain: "robinhood-testnet", agentId: "4", tx: "0x" + "1".repeat(64) },
        verified: true,
      },
      { ...entry("Unposted", 83, 50), verified: null },
    ]);
    const r = row("AgentKit chatbot");
    expect(within(r).getByRole("link", { name: "AgentKit chatbot" }).getAttribute("href")).toBe(
      "/agents/4",
    );
    expect(within(r).getByText("deepseek-v4.1-flash · Coinbase AgentKit")).toBeTruthy();
    expect(within(r).getByRole("link", { name: "source ↗" }).getAttribute("href")).toBe(
      "https://example.com/agentkit",
    );
    // Disclosure status isn't shown on the board.
    expect(within(r).queryByText("maintainer notice pending")).toBeNull();
    expect(within(r).getByText("Verified")).toBeTruthy();
    expect(within(row("Unposted")).getByText("Not on chain")).toBeTruthy();
    expect(within(row("Unposted")).queryByRole("link", { name: "Unposted" })).toBeNull();
  });
});

describe("attack library versions", () => {
  it("tags results from an older library or before versions, and not current ones", async () => {
    const row = await renderBoard([
      { ...entry("Current", 50, 90), libraryVersion: ATTACK_LIBRARY_VERSION },
      { ...entry("Older", 50, 95), libraryVersion: ATTACK_LIBRARY_VERSION - 1 },
      entry("Unversioned", 50, 85),
    ]);
    expect(within(row("Current")).queryByText(/library v/)).toBeNull();
    expect(
      within(row("Older")).getByText(
        `Rated on library v${ATTACK_LIBRARY_VERSION - 1}; current is v${ATTACK_LIBRARY_VERSION}`,
      ),
    ).toBeTruthy();
    expect(within(row("Unversioned")).getByText("Rated before library versions")).toBeTruthy();
  });
});
