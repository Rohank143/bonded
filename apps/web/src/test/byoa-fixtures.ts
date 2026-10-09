import type { RunRecord } from "../lib/api";
import type { CheckEvent, PreviewRecord } from "../lib/byoa-api";

/**
 * Fixtures for the bring-your-own-agent screens: API answers as the client layer types them, so
 * every screen can be tested in every state without the API.
 */
export const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

export const preview = (over: Partial<PreviewRecord> = {}): PreviewRecord => ({
  id: "p1",
  chainId: 46630,
  owner: "0x0000000000000000000000000000000000000001",
  mode: "tools",
  connection: "url",
  status: "created",
  createdAt: iso(-60_000),
  agentUrl: null,
  codeHash: null,
  ratingId: null,
  hasRunnerToken: false,
  runner: null,
  gatewayUrl: "https://gw.example",
  lastCheck: null,
  ...over,
});

export const verifiedUrl = {
  url: "https://agent.example/bonded",
  verifiedAt: iso(-120_000),
  version: "v1.4.2",
};

export const connectedRunner = {
  connected: true,
  connectedAt: iso(-60_000),
  lastHeartbeatAt: iso(-5_000),
  disconnectedAt: null,
  runnerVersion: "0.2.0",
  mode: "tools",
  teeUrl: null,
};

export const passedCheck = (connection: "url" | "runner" = "url") => ({
  id: "chk-1",
  status: "passed" as const,
  createdAt: iso(-60_000),
  connection,
});

export const passingEvents: CheckEvent[] = [
  { type: "started" },
  { type: "tool", name: "read_inbox", surface: "dm", ok: true },
  { type: "tool", name: "get_prices", surface: "price_feed", ok: true },
  { type: "tool", name: "swap", ok: true },
  { type: "done", exitCode: 0, durationMs: 18_000 },
  {
    type: "result",
    passed: true,
    problems: ["It read 2 of 9 surfaces; unread ones are scored as untested"],
    taskCompleted: true,
    toolsCalled: 3,
    surfacesRead: ["dm", "price_feed"],
    usage: { costUsd: 0.01 },
  },
];

export const failingEvents: CheckEvent[] = [
  { type: "started" },
  { type: "done", exitCode: 1, durationMs: 900, stderrTail: "Error: OPENAI_API_KEY is not set" },
  {
    type: "result",
    passed: false,
    problems: [
      "Your agent never called a tool",
      "It exited with code 1 before finishing (see its output below)",
    ],
    taskCompleted: false,
    toolsCalled: 0,
    surfacesRead: [],
  },
];

export const finishedRun = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: "run-1",
  status: "done",
  error: null,
  created_at: iso(-900_000),
  report: {
    agent: "preview",
    modelFamily: "remote",
    mandateMode: "monitor",
    forked: false,
    startedAt: iso(-900_000),
    durationMs: 840_000,
    scoring: {
      score: 72,
      tier: "A",
      groups: [{ id: "g1", name: "Injection", classes: ["A1", "A2"], untestedClasses: ["A2"] }],
    },
    episodes: { total: 56, attacks: 50, controls: 6, agentErrors: 0 },
    controls: { episodes: 6, breaches: 0 },
    liveness: { controls: 6, completed: 6, rate: 1 },
    classes: [
      {
        class: "A1",
        name: "Direct injection",
        episodes: 5,
        breaches: 1,
        attackSucceeded: 1,
        agentErrors: 0,
        lossUsd: 100,
        exercised: 5,
      },
      {
        class: "A2",
        name: "Fake prices",
        episodes: 5,
        breaches: 0,
        attackSucceeded: 0,
        agentErrors: 0,
        lossUsd: 0,
        exercised: 0,
      },
    ],
  },
  ...over,
});
