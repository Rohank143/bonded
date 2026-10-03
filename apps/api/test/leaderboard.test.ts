import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { Database } from "@bonded/db";
import type { ServiceChain } from "@bonded/keeper";
import { createApi } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "lb-api-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const hash = (b: string) => `0x${b.repeat(32)}`;
const entry = (slug: string, score: number, agentId: string | null, a2: number) => ({
  slug,
  name: slug,
  kind: "framework",
  framework: "Coinbase AgentKit",
  model: "m",
  ratedAt: "2026-10-03T12:00:00.000Z",
  score,
  tier: "CCC",
  expectedLossBps: 1000,
  premiumRateBps: 1500,
  insurable: true,
  episodes: { attacks: 40, controls: 2, controlBreaches: 0 },
  classes: [{ class: "A2", name: "Injection via content", episodes: 4, breaches: a2 }],
  reportHash: hash("ab"),
  onchain: agentId ? { chain: "robinhoodTestnet", agentId, tx: hash("cd") } : null,
  disclosure: { status: "pending" },
});

it("serves the leaderboard with the headline and checks each score on chain", async () => {
  const file = join(dir, "leaderboard.json");
  writeFileSync(
    file,
    JSON.stringify([entry("a", 40, "7", 2), entry("b", 70, "8", 0), entry("c", 55, null, 1)]),
  );
  const chain = {
    deployment: { chainId: 46630, registry: "0x0000000000000000000000000000000000000001" },
    read: {
      // Agent 7's posted score matches; agent 8's has been replaced since.
      readContract: async ({ args }: { args: [bigint] }) =>
        args[0] === 7n
          ? { score: 40, reportHash: hash("ab") }
          : { score: 71, reportHash: hash("ef") },
    },
  } as unknown as ServiceChain;
  const app = createApi({
    db: { pool: {} } as unknown as Database,
    chain,
    attesterKey: hash("11") as `0x${string}`,
    apiToken: "test-api-token-at-least-24-characters",
    leaderboardFile: file,
  });
  const body = (await (await app.request("/leaderboard")).json()) as {
    headline: Record<string, number>;
    entries: { slug: string; verified: boolean | null }[];
  };
  expect(body.headline).toEqual({
    templates: 1,
    failingTemplates: 1,
    evaluations: 3,
    failingEvaluations: 2,
  });
  expect(body.entries.map((e) => [e.slug, e.verified])).toEqual([
    ["a", true],
    ["b", false],
    ["c", null],
  ]);
});
