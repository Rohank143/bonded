import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACK_LIBRARY_VERSION, type LeaderboardEntry } from "@bondedhq/shared";
import { keccak256, stringToBytes } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRating } from "../src/leaderboard-add.js";
import { readLeaderboard } from "../src/leaderboard.js";
import {
  defaultHeldOutDir,
  metaOf,
  describeOutcomes,
  describePlan,
  planRefresh,
  rateArgs,
  ratingState,
  refreshRunDir,
  refreshTarget,
  type RefreshDeps,
  type RefreshJob,
  runRefresh,
} from "../src/leaderboard-refresh.js";

const entry = (slug: string, over: Partial<LeaderboardEntry> = {}): LeaderboardEntry => ({
  slug,
  name: slug,
  kind: "framework",
  framework: "Coinbase AgentKit",
  model: "deepseek/deepseek-v4.1-flash",
  ratedAt: "2026-10-19T21:54:19.592Z",
  libraryVersion: ATTACK_LIBRARY_VERSION,
  securityGrade: 70,
  score: 60,
  tier: "BBB",
  expectedLossBps: 100,
  premiumRateBps: 200,
  insurable: true,
  episodes: { attacks: 350, controls: 2, controlBreaches: 0 },
  classes: [],
  reportHash: `0x${"ab".repeat(32)}`,
  onchain: { chain: "robinhoodTestnet", agentId: "4", tx: `0x${"cd".repeat(32)}` },
  disclosure: { status: "pending" },
  ...over,
});

const scripted = entry("bonded-hardened-scripted", {
  kind: "reference",
  framework: "Bonded demo agent (scripted)",
  model: null,
});

/** Writes a rating folder as `arena rate` would: report.json and an attestation over its bytes. */
function writeRating(
  dir: string,
  opts: { stoppedEarly?: string; agentErrors?: number; spentUsd?: number; version?: number } = {},
) {
  mkdirSync(dir, { recursive: true });
  const report = {
    version: 1,
    ...(opts.version === 0 ? {} : { libraryVersion: opts.version ?? ATTACK_LIBRARY_VERSION }),
    startedAt: "2026-10-21T10:00:00.000Z",
    scoring: { score: 55, tier: "BB", expectedLossBps: 300, premiumRateBps: 500, insurable: true },
    susceptibility: { grade: 80, worstClass: "A2", worstTrack: "s2", classes: [] },
    episodes: { total: 352, attacks: 350, controls: 2, agentErrors: opts.agentErrors ?? 0 },
    controls: { episodes: 2, breaches: 0 },
    classes: [],
    stoppedEarly: opts.stoppedEarly ?? null,
    spend: { spentUsd: opts.spentUsd ?? 0, maxUsd: null, estimated: false },
  };
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  const reportHash = keccak256(stringToBytes(bytes));
  writeFileSync(join(dir, "report.json"), bytes);
  writeFileSync(
    join(dir, "attestation.json"),
    JSON.stringify({
      reportHash,
      attestation: {
        agentId: "1",
        score: 55,
        securityScore: 80,
        expectedLossBps: 300,
        reportHash,
        mandateHash: `0x${"11".repeat(32)}`,
        codeHash: `0x${"22".repeat(32)}`,
        teeMeasurement: `0x${"00".repeat(32)}`,
        modelFamily: "deepseek",
        issuedAt: 1_790_000_000,
        expiresAt: 1_792_592_000,
      },
    }),
  );
}

const settings = { repeats: 5, episodeTimeoutS: 900, heldOut: "/held-out/2026-10-05" };
const flag = (args: string[], name: string) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;

let root: string;
let runDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "refresh-"));
  runDir = refreshRunDir(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A fake `arena rate`: each call does what `script` says for that slug, in turn. */
function fakeDeps(
  script: Record<string, ("ok" | "stopped" | "errors" | "crash")[]>,
  spentUsd = 0.4,
) {
  const calls: { slug: string; args: string[] }[] = [];
  const added: string[] = [];
  const lines: string[] = [];
  const deps: RefreshDeps = {
    rate: async (job: RefreshJob, args: string[]) => {
      calls.push({ slug: job.entry.slug, args });
      const step = script[job.entry.slug]?.shift() ?? "ok";
      const spend = job.target.brain === "llm" ? spentUsd : 0;
      if (step === "crash") {
        mkdirSync(flag(args, "--out")!, { recursive: true });
        return 1;
      }
      writeRating(flag(args, "--out")!, {
        spentUsd: spend,
        ...(step === "stopped" ? { stoppedEarly: "episode timed out" } : {}),
        ...(step === "errors" ? { agentErrors: 3 } : {}),
      });
      return 0;
    },
    add: async (job) => {
      added.push(job.entry.slug);
      return { entry: job.entry };
    },
    log: (line) => lines.push(line),
  };
  return { deps, calls, added, lines };
}

describe("what each entry is re-rated with", () => {
  it("maps frameworks and Bonded's reference agents to arena rate agents", () => {
    expect(refreshTarget(entry("a"))).toEqual({
      agent: "agentkit",
      brain: "llm",
      model: "deepseek/deepseek-v4.1-flash",
    });
    expect(refreshTarget(entry("s", { framework: "Solana Agent Kit" })).agent).toBe(
      "solana-agent-kit",
    );
    expect(refreshTarget(scripted)).toEqual({ agent: "hardened", brain: "scripted", model: null });
    expect(refreshTarget({ ...scripted, slug: "bonded-vulnerable-scripted" }).agent).toBe(
      "vulnerable",
    );
  });

  it("refuses an entry no rule covers, saying where to add one", () => {
    expect(() => refreshTarget(entry("x", { framework: "ElizaOS" }))).toThrow(/FRAMEWORK_AGENTS/);
    expect(() => refreshTarget(entry("y", { model: null }))).toThrow(/needs a model/);
  });

  it("passes the standard settings, and a spending cap only to model-driven agents", () => {
    const model = rateArgs({ target: refreshTarget(entry("a")), dir: "/r/a" }, settings, 0.8);
    expect(model).toEqual([
      "rate",
      "--agent",
      "agentkit",
      "--model",
      "deepseek/deepseek-v4.1-flash",
      "--repeats",
      "5",
      "--held-out",
      "/held-out/2026-10-05",
      "--episode-timeout",
      "900",
      "--max-usd",
      "0.80",
      "--out",
      "/r/a",
    ]);
    const plain = rateArgs({ target: refreshTarget(scripted), dir: "/r/h" }, settings, 0.8);
    expect(plain.slice(0, 5)).toEqual(["rate", "--agent", "hardened", "--brain", "scripted"]);
    expect(plain).not.toContain("--max-usd");
    expect(plain).not.toContain("--model");
    expect(
      rateArgs({ target: refreshTarget(scripted), dir: "/r/h" }, { ...settings, heldOut: null }),
    ).not.toContain("--held-out");
  });
});

describe("planning a refresh", () => {
  it("skips complete ratings and re-rates missing, failed and stale ones", () => {
    const entries = [entry("done"), entry("stopped"), entry("stale"), entry("new"), scripted];
    writeRating(join(runDir, "done"));
    writeRating(join(runDir, "stopped"), { stoppedEarly: "episode timed out", spentUsd: 0.2 });
    writeRating(join(runDir, "stale"), { version: 0 });
    const plan = planRefresh({ entries, runDir });
    expect(plan.jobs.map((j) => [j.entry.slug, j.action])).toEqual([
      ["done", "skip"],
      ["stopped", "rate"],
      ["stale", "rate"],
      ["new", "rate"],
      ["bonded-hardened-scripted", "rate"],
    ]);
    expect(plan.jobs[1]!.reason).toMatch(/stopped early/);
    expect(plan.jobs[2]!.reason).toMatch(/no version/);
    expect(plan.jobs[3]!.reason).toBe("not rated yet");
    // Three model ratings at the default estimate; the scripted agent is free.
    expect(plan.estimateUsd).toBeCloseTo(3 * 0.45);
    expect(plan.spentUsd).toBeCloseTo(0.2);
    const text = describePlan(plan, settings, 1).join("\n");
    expect(text).toContain("5 entries, 4 to rate, 1 already complete");
    expect(text).toContain("over it");
  });

  it("plans only the entries asked for, and refuses unknown slugs", () => {
    const entries = [entry("a"), entry("b"), scripted];
    expect(planRefresh({ entries, runDir, only: ["b"] }).jobs.map((j) => j.entry.slug)).toEqual([
      "b",
    ]);
    expect(() => planRefresh({ entries, runDir, only: ["b", "zzz"] })).toThrow(/zzz/);
  });

  it("calls a folder without a report unfinished", () => {
    mkdirSync(join(runDir, "a"), { recursive: true });
    expect(ratingState(join(runDir, "a"))).toMatchObject({
      status: "failed",
      reason: "no report (the rating didn't finish)",
    });
    expect(ratingState(join(runDir, "b"))).toEqual({ status: "missing" });
  });
});

describe("running and resuming a refresh", () => {
  it("retries a failed rating, publishes nothing until all are complete, then resumes", async () => {
    const entries = [entry("a"), entry("b"), scripted];
    const first = fakeDeps({ b: ["stopped", "errors"] });
    const one = await runRefresh(
      planRefresh({ entries, runDir }),
      { settings, maxUsd: 5 },
      first.deps,
    );
    expect(one.outcomes.map((o) => [o.slug, o.status, o.attempts])).toEqual([
      ["a", "rated", 1],
      ["b", "failed", 2],
      ["bonded-hardened-scripted", "rated", 1],
    ]);
    expect(one.outcomes[1]!.detail).toMatch(/agent error/);
    expect(one.published).toBe(false);
    expect(first.added).toEqual([]);
    // Both failed attempts are kept aside, and their spend counts.
    expect(existsSync(join(runDir, "b.failed-1"))).toBe(true);
    expect(one.spentUsd).toBeCloseTo(0.4 * 3);
    expect(describeOutcomes(one, { post: true, maxUsd: 5 }).join("\n")).toContain(
      "run the same command again to retry only those; nothing was published",
    );

    // The next run rates only b, and then publishes all three together, in board order.
    const second = fakeDeps({});
    const plan = planRefresh({ entries, runDir });
    expect(plan.jobs.map((j) => j.action)).toEqual(["skip", "rate", "skip"]);
    expect(plan.spentUsd).toBeCloseTo(0.4 * 3);
    const two = await runRefresh(plan, { settings, maxUsd: 5 }, second.deps);
    expect(second.calls.map((c) => c.slug)).toEqual(["b"]);
    expect(existsSync(join(runDir, "b.failed-2"))).toBe(true);
    expect(two.outcomes.map((o) => o.status)).toEqual(["skipped", "rated", "skipped"]);
    expect(two.outcomes[0]).toMatchObject({ previousGrade: 70, grade: 80, score: 55 });
    expect(two.published).toBe(true);
    expect(second.added).toEqual(["a", "b", "bonded-hardened-scripted"]);

    // A third run has nothing to rate and only re-publishes (a no-op for scores already posted).
    const third = fakeDeps({});
    await runRefresh(planRefresh({ entries, runDir }), { settings }, third.deps);
    expect(third.calls).toEqual([]);
    expect(third.added).toHaveLength(3);
  });

  it("treats a crash that wrote nothing as a failure", async () => {
    const deps = fakeDeps({ a: ["crash"] });
    const result = await runRefresh(
      planRefresh({ entries: [entry("a")], runDir }),
      { settings, maxUsd: 5, attempts: 1 },
      deps.deps,
    );
    expect(result.outcomes[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(result.outcomes[0]!.detail).toMatch(/didn't finish/);
  });

  it("shares the total cap: each rating gets what's left, and none starts without enough", async () => {
    const entries = [entry("a"), entry("b"), entry("c"), scripted];
    writeRating(join(runDir, "earlier.failed-1"), { stoppedEarly: "x", spentUsd: 0.3 });
    const deps = fakeDeps({}, 0.6);
    const result = await runRefresh(
      planRefresh({ entries, runDir }),
      { settings, maxUsd: 1.5, perRatingMaxUsd: 1 },
      deps.deps,
    );
    // $0.30 already spent: a gets the per-rating $1.00 and spends $0.60, b gets the $0.60 left
    // and spends it, so c doesn't start.
    expect(deps.calls.map((c) => [c.slug, flag(c.args, "--max-usd")])).toEqual([
      ["a", "1.00"],
      ["b", "0.60"],
      ["bonded-hardened-scripted", undefined],
    ]);
    expect(result.outcomes.find((o) => o.slug === "c")).toMatchObject({ status: "budget" });
    expect(result.published).toBe(false);
  });

  it("requires a total cap when a model-driven entry needs rating, but not for scripted ones", async () => {
    await expect(
      runRefresh(planRefresh({ entries: [entry("a")], runDir }), { settings }, fakeDeps({}).deps),
    ).rejects.toThrow(/--max-usd/);
    const deps = fakeDeps({});
    const result = await runRefresh(
      planRefresh({ entries: [scripted], runDir }),
      { settings },
      deps.deps,
    );
    expect(result.published).toBe(true);
  });

  it("runs ratings in parallel when asked, within the cap", async () => {
    let inFlight = 0;
    let most = 0;
    const deps = fakeDeps({});
    const rate = deps.deps.rate;
    deps.deps.rate = async (job, args, attempt) => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return rate(job, args, attempt);
    };
    const result = await runRefresh(
      planRefresh({ entries: [entry("a"), entry("b"), entry("c")], runDir }),
      { settings, maxUsd: 1.5, perRatingMaxUsd: 0.5, parallel: 3 },
      deps.deps,
    );
    expect(most).toBe(3);
    expect(deps.calls.map((c) => flag(c.args, "--max-usd"))).toEqual(["0.50", "0.50", "0.50"]);
    expect(result.outcomes.every((o) => o.status === "rated")).toBe(true);
  });

  it("publishes the complete entries with --publish-partial, and reports a failed post", async () => {
    const deps = fakeDeps({ b: ["stopped"] });
    deps.deps.add = async (job) => {
      if (job.entry.slug === "c") throw new Error("RPC down");
      deps.added.push(job.entry.slug);
      return { entry: job.entry, posted: { agentId: "4", status: "posted", tx: "0xfeed" } };
    };
    const result = await runRefresh(
      planRefresh({ entries: [entry("a"), entry("b"), entry("c")], runDir }),
      { settings, maxUsd: 5, attempts: 1, publishPartial: true },
      deps.deps,
    );
    expect(deps.added).toEqual(["a"]);
    expect(result.outcomes[0]!.posted?.tx).toBe("0xfeed");
    expect(result.outcomes[2]!.postError).toBe("RPC down");
    const summary = describeOutcomes(result, { post: true }).join("\n");
    expect(summary).toContain("posted 0xfeed");
    expect(summary).toContain("NOT published: RPC down");
  });
});

it("defaults to the newest held-out folder", () => {
  const dir = join(root, "held-out");
  for (const d of ["2026-09-01", "2026-10-05", "2026-09-20"])
    mkdirSync(join(dir, d), { recursive: true });
  expect(defaultHeldOutDir(dir)).toBe(join(dir, "2026-10-05"));
  expect(defaultHeldOutDir(join(root, "none"))).toBeUndefined();
});

it("re-adds a refreshed entry under its own identity, unposted until posted", async () => {
  const file = join(root, "leaderboard.json");
  const old = entry("a", { template: "https://github.com/coinbase/agentkit" });
  writeFileSync(file, JSON.stringify([old]));
  writeRating(join(runDir, "a"));
  const { entry: fresh, posted } = await addRating({
    ratingDir: join(runDir, "a"),
    meta: metaOf(old),
    file,
    post: false,
    attesterEnv: "DEPLOYER_PRIVATE_KEY",
  });
  expect(posted).toBeUndefined();
  expect(fresh).toMatchObject({
    slug: "a",
    template: "https://github.com/coinbase/agentkit",
    disclosure: { status: "pending" },
    libraryVersion: ATTACK_LIBRARY_VERSION,
    securityGrade: 80,
    ratedAt: "2026-10-21T10:00:00.000Z",
    // The same agent, but the new score isn't on chain yet.
    onchain: { chain: "robinhoodTestnet", agentId: "4", tx: null },
  });
  expect(readLeaderboard(file)).toEqual([fresh]);
});
