import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { ANVIL_KEYS } from "@bonded/arena";
import { connectChain } from "@bonded/keeper";
import { parseEvmDeployment } from "@bonded/shared";
import { createApi } from "../src/index.js";
import { postgres } from "./postgres.js";

let pg: Awaited<ReturnType<typeof postgres>>;
let app: ReturnType<typeof createApi>;
const chain = connectChain(
  parseEvmDeployment(
    readFileSync(new URL("../../../contracts/evm/deployments/46630.json", import.meta.url), "utf8"),
  ),
  "http://127.0.0.1:1",
  ANVIL_KEYS.deployer,
);
const RUN_A = "00000000-0000-4000-8000-00000000000a";
const RUN_B = "00000000-0000-4000-8000-00000000000b";

/** Publish one episode the way the Arena worker does (topic rating.episode). */
const episode = (runId: string, index: number, attackClass: string | null, breached = false) =>
  pg.db.publish("rating.episode", {
    runId,
    index,
    total: 10,
    episode: {
      attackId: attackClass ? `${attackClass}-x-${index}` : null,
      attackClass,
      verdict: { breached, totalLossUsd: breached ? 250 : 0, frozen: false },
    },
  });

type EpisodesPage = {
  items: { eventId: string; runId: string; index: number; breached: boolean }[];
  next: string | null;
  through?: string;
  counts?: { total: number; held: number; breach: number; control: number };
};
const get = async (path: string) => {
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return (await res.json()) as EpisodesPage;
};

beforeAll(async () => {
  pg = await postgres();
  app = createApi({
    db: pg.db,
    chain,
    attesterKey: ANVIL_KEYS.deployer,
    apiToken: "pagination-test-token-at-least-24-chars",
    episodeCountsCacheMs: 0,
  });
}, 120_000);
afterAll(async () => {
  await app?.close();
  await pg?.stop();
});
beforeEach(async () => {
  await pg.db.pool.query("TRUNCATE events, bounties");
  // Run A: a control, then attacks A1..A5, with a breach on A3. Run B: two held attacks.
  await episode(RUN_A, 0, null);
  for (let i = 1; i <= 5; i++) await episode(RUN_A, i, `A${i}`, i === 3);
  await pg.db.publish("claim.paid", { vault: "0x1" });
  await episode(RUN_B, 0, "A1");
  await episode(RUN_B, 1, "A2");
});

it("pages episodes newest first with a cursor, and nothing is skipped or repeated", async () => {
  const first = await get("/episodes?limit=3");
  expect(first.items.map((e) => `${e.runId.at(-1)}${e.index}`)).toEqual(["b1", "b0", "a5"]);
  expect(first.next).toBe(first.items[2]!.eventId);
  const seen = [...first.items];
  let next = first.next;
  while (next) {
    const page = await get(`/episodes?limit=3&before=${next}`);
    // Later pages don't recount or return the stream position.
    expect(page.counts).toBeUndefined();
    expect(page.through).toBeUndefined();
    seen.push(...page.items);
    next = page.next;
  }
  expect(seen).toHaveLength(8);
  expect(new Set(seen.map((e) => e.eventId)).size).toBe(8);
  // Only episodes: the claim event is not in the list.
  expect(seen.map((e) => Number(e.eventId))).toEqual(
    [...seen.map((e) => Number(e.eventId))].sort((a, b) => b - a),
  );
});

it("filters by run, outcome and class in the database, so pages stay full", async () => {
  const breaches = await get("/episodes?outcome=breach");
  expect(breaches.items).toHaveLength(1);
  expect(breaches.items[0]).toMatchObject({ runId: RUN_A, index: 3, breached: true });

  const controls = await get("/episodes?outcome=control");
  expect(controls.items.map((e) => e.index)).toEqual([0]);

  const heldA = await get(`/episodes?runId=${RUN_A}&outcome=held&limit=2`);
  expect(heldA.items.map((e) => e.index)).toEqual([5, 4]);
  expect(heldA.next).not.toBeNull();
  const rest = await get(`/episodes?runId=${RUN_A}&outcome=held&limit=2&before=${heldA.next}`);
  expect(rest.items.map((e) => e.index)).toEqual([2, 1]);
  expect(rest.next).toBeNull();

  const a1 = await get("/episodes?class=A1");
  expect(a1.items.map((e) => e.runId)).toEqual([RUN_B, RUN_A]);
});

it("counts outcomes through an event id, where the live stream resumes", async () => {
  const all = await get("/episodes");
  expect(all.counts).toEqual({ total: 8, held: 6, breach: 1, control: 1 });
  const latest = await pg.db.pool.query("SELECT max(id)::text AS id FROM events");
  expect(all.through).toBe(latest.rows[0].id);
  const runB = await get(`/episodes?runId=${RUN_B}`);
  expect(runB.counts).toEqual({ total: 2, held: 2, breach: 0, control: 0 });
});

it("reuses a count only with its own through, so the live stream fills the gap exactly", async () => {
  const cachedApp = createApi({
    db: pg.db,
    chain,
    attesterKey: ANVIL_KEYS.deployer,
    apiToken: "pagination-test-token-at-least-24-chars",
    episodeCountsCacheMs: 60_000,
  });
  try {
    const read = async () => (await (await cachedApp.request("/episodes")).json()) as EpisodesPage;
    const before = await read();
    await episode(RUN_B, 2, "A3", true);
    const after = await read();
    // Same count and through, but the new episode is on the first page.
    expect(after.counts).toEqual(before.counts);
    expect(after.through).toBe(before.through);
    expect(after.items[0]).toMatchObject({ runId: RUN_B, index: 2, breached: true });
    expect(Number(after.items[0]!.eventId)).toBeGreaterThan(Number(after.through));
  } finally {
    await cachedApp.close();
  }
});

it("rejects bad cursors and page sizes", async () => {
  for (const q of ["before=abc", "limit=0", "limit=101", "outcome=lost", "class=Z9", "runId=1"])
    expect((await app.request(`/episodes?${q}`)).status).toBe(400);
  expect((await app.request("/bounties?before=-1")).status).toBe(400);
});

it("pages bounties by submission id, newest first", async () => {
  for (let id = 1; id <= 5; id++)
    await pg.db.pool.query(
      `INSERT INTO bounties(chain_id,submission_id,hunter,spec_uri,spec_yaml,spec)
       VALUES($1,$2,'0xhunter','uri','yaml',$3)`,
      [
        chain.deployment.chainId,
        id,
        JSON.stringify({ id: `A1-b-${id}`, class: "A1", title: `T${id}`, surfaces: ["dm"] }),
      ],
    );
  const page = async (q: string) =>
    (await (await app.request(`/bounties?${q}`)).json()) as {
      items: { submissionId: string }[];
      next: string | null;
    };
  const first = await page("limit=2");
  expect(first.items.map((b) => b.submissionId)).toEqual(["5", "4"]);
  const second = await page(`limit=2&before=${first.next}`);
  expect(second.items.map((b) => b.submissionId)).toEqual(["3", "2"]);
  const last = await page(`limit=2&before=${second.next}`);
  expect(last).toEqual({ items: [expect.objectContaining({ submissionId: "1" })], next: null });
});
