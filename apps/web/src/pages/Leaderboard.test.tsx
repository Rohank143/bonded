import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("leaderboard security grades", () => {
  it("ranks security grades, including zero, and leaves legacy insurance results unranked", async () => {
    vi.spyOn(api, "leaderboard").mockResolvedValue({
      headline: { templates: 0, failingTemplates: 0, evaluations: 0, failingEvaluations: 0 },
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
    expect(within(rows[0]!).getByText("90")).toBeTruthy();
    expect(within(rows[1]!).getByText("0")).toBeTruthy();
    expect(within(rows[2]!).getByText("—")).toBeTruthy();
    expect(within(rows[2]!).getByText("Security not measured")).toBeTruthy();
    expect(within(rows[2]!).getByText("Insurance score 100")).toBeTruthy();
    // A legacy entry measured breaches only: no claim about manipulation.
    expect(within(rows[2]!).getByText(/No breaches in/)).toBeTruthy();
    expect(within(rows[2]!).queryByText("100")).toBeNull();
    // Three total results do not constitute a security podium when one is legacy.
    expect(screen.queryByText("#1")).toBeNull();
  });

  it("names the weakest row's battery and sums up the market-data and memory batteries", async () => {
    vi.spyOn(api, "leaderboard").mockResolvedValue({
      headline: { templates: 0, failingTemplates: 0, evaluations: 0, failingEvaluations: 0 },
      entries: [
        {
          ...entry("Graded", 81, 25),
          worstClass: "A8",
          worstTrack: "s1",
          classes: [
            {
              class: "A2",
              name: "Injection via content",
              episodes: 10,
              manipulated: 3,
              breaches: 1,
            },
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
          ],
          memoryClasses: [{ class: "A2", counted: 5, manipulated: 1, graded: true }],
        },
      ],
    });
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <Leaderboard />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const row = within(await screen.findByRole("list", { name: "Security rankings" })).getAllByRole(
      "listitem",
    )[0]!;
    expect(within(row).getByText("Weakest: A8, market data")).toBeTruthy();
    // The strip counts manipulation, not only breaches.
    expect(within(row).getByText(/Manipulated in 3 of 10 episodes, 1 breached/)).toBeTruthy();
    expect(
      within(row).getByText(
        "Market data: false data moved it to act in 10 of 20 pairs, froze it in 2",
      ),
    ).toBeTruthy();
    expect(
      within(row).getByText("Memory: acted on a planted note in 1 of 5 attempts"),
    ).toBeTruthy();
  });

  it("leads the headline with false market data once templates ran it", async () => {
    const template = (model: string, manipulated: number): LeaderboardRecord => ({
      ...entry(`AgentKit ${model}`, 83, 20),
      slug: `agentkit-${model}`,
      kind: "framework",
      template: "https://example.com/agentkit",
      s1Classes: [
        { class: "A2", counted: 18, manipulated, inducedInaction: 0, breaches: 0, graded: true },
      ],
    });
    vi.spyOn(api, "leaderboard").mockResolvedValue({
      headline: { templates: 1, failingTemplates: 0, evaluations: 2, failingEvaluations: 0 },
      entries: [template("deepseek", 15), template("glm", 0)],
    });
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <Leaderboard />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(
      await screen.findByText("1 of 1 popular agent templates traded on false market data."),
    ).toBeTruthy();
    expect(
      screen.getByText(/moved 1 of 2 template and model pairs to trade on the lie/),
    ).toBeTruthy();
    expect(
      screen.getByText(/None of the 1 popular agent templates fell for basic prompt injection/),
    ).toBeTruthy();
  });
});
