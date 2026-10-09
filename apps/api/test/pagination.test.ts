import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { ANVIL_KEYS, loadAttackLibrary } from "@bonded/arena";
import { connectChain } from "@bonded/keeper";
import { parseEvmDeployment } from "@bondedhq/shared";
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

/** A real published seed of a class: whether an attack is published is read from the library. */
const LIBRARY = loadAttackLibrary();
const seedOf = (attackClass: string, index: number) => {
  const seeds = LIBRARY.filter((a) => a.class === attackClass);
  return seeds[index % seeds.length]!.id;
};

/** Publish one episode the way the Arena worker does (topic rating.episode). */
const episode = (
  runId: string,
  index: number,
  attackClass: string | null,
  breached = false,
  attackId = attackClass ? seedOf(attackClass, index) : null,
) =>
  pg.db.publish("rating.episode", {
    runId,
    index,
    total: 10,
    episode: {
      attackId,
      attackClass,
      verdict: { breached, totalLossUsd: breached ? 250 : 0, frozen: false },
    },
  });

type Counts = { total: number; held: number; breach: number; control: number };
type EpisodesPage = {
  items: {
    eventId: string;
    runId: string;
    index: number;
    breached: boolean;
    agentId: string | null;
  }[];
  page: number;
  pages: number;
  total: number;
  through: string;
  counts: Counts;
};
const get = async (path: string) => {
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return (await res.json()) as EpisodesPage;
};
const tag = (p: EpisodesPage) => p.items.map((e) => `${e.runId.at(-1)}${e.index}`);

beforeAll(async () => {
  pg = await postgres();
  app = createApi({
    db: pg.db,
    chain,
    attesterKey: ANVIL_KEYS.deployer,
    apiToken: "pagination-test-token-at-least-24-chars",
  });
}, 120_000);
afterAll(async () => {
  await app?.close();
  await pg?.stop();
});
beforeEach(async () => {
  await pg.db.pool.query("TRUNCATE events, bounties, ratings, agents CASCADE");
  // Run A is agent 7's rating: a control, then attacks A1..A5, with a breach on A3 and a
  // held-out attack on A5. Run B (no rating row) has two held attacks.
  await pg.db.pool.query("INSERT INTO agents(id,chain_id,agent_id,config) VALUES($1,$2,7,'{}')", [
    `${chain.deployment.chainId}:7`,
    chain.deployment.chainId,
  ]);
  await pg.db.pool.query("INSERT INTO ratings(id,agent_id,status) VALUES($1,$2,'done')", [
    RUN_A,
    `${chain.deployment.chainId}:7`,
  ]);
  await episode(RUN_A, 0, null);
  for (let i = 1; i <= 4; i++) await episode(RUN_A, i, `A${i}`, i === 3);
  await episode(RUN_A, 5, "A5", false, "A5-held-out-1a2b3c4d");
  await pg.db.publish("claim.paid", { vault: "0x1" });
  await episode(RUN_B, 0, "A1");
  await episode(RUN_B, 1, "A2");
});

it("numbers pages of a snapshot that new episodes don't shift", async () => {
  const first = await get("/episodes?limit=3");
  expect(first).toMatchObject({ page: 1, pages: 3, total: 8 });
  expect(tag(first)).toEqual(["b1", "b0", "a5"]);

  // An episode arrives; page 2 of the same snapshot still shows the rows after page 1.
  await episode(RUN_B, 2, "A3");
  const second = await get(`/episodes?limit=3&page=2&through=${first.through}`);
  expect(tag(second)).toEqual(["a4", "a3", "a2"]);
  expect(second.total).toBe(8);
  const third = await get(`/episodes?limit=3&page=3&through=${first.through}`);
  expect(tag(third)).toEqual(["a1", "a0"]);

  // A page past the end reads the last page; a new snapshot includes the new episode.
  expect(tag(await get(`/episodes?limit=3&page=9&through=${first.through}`))).toEqual(["a1", "a0"]);
  const fresh = await get("/episodes?limit=3");
  expect(fresh.total).toBe(9);
  expect(tag(fresh)[0]).toBe("b2");
  expect(Number(fresh.through)).toBeGreaterThan(Number(first.through));
});

it("filters in the database, and counts outcomes with every filter but the outcome", async () => {
  const all = await get("/episodes");
  expect(all.counts).toEqual({ total: 8, held: 6, breach: 1, control: 1 });

  const breaches = await get("/episodes?outcome=breach");
  expect(breaches.total).toBe(1);
  expect(breaches.items[0]).toMatchObject({ runId: RUN_A, index: 3, breached: true });
  // The chips still show every outcome's count.
  expect(breaches.counts).toEqual(all.counts);

  const a1 = await get("/episodes?class=A1");
  expect(a1.items.map((e) => e.runId)).toEqual([RUN_B, RUN_A]);
  expect(a1.counts).toEqual({ total: 2, held: 2, breach: 0, control: 0 });

  expect(tag(await get(`/episodes?runId=${RUN_B}`))).toEqual(["b1", "b0"]);
  expect(tag(await get("/episodes?source=held-out"))).toEqual(["a5"]);
  expect(tag(await get(`/episodes?attack=${seedOf("A2", 2)}`))).toEqual(["a2"]);
  expect((await get("/episodes?source=library")).total).toBe(6);
  expect((await get("/episodes?since=1h")).total).toBe(8);
  await pg.db.pool.query("UPDATE events SET created_at = now() - interval '2 days'");
  expect((await get("/episodes?since=24h")).total).toBe(0);
  expect((await get("/episodes?since=7d")).total).toBe(8);
});

it("filters by agent and names each episode's agent", async () => {
  const mine = await get("/episodes?agentId=7");
  expect(mine.total).toBe(6);
  expect(new Set(mine.items.map((e) => e.agentId))).toEqual(new Set(["7"]));
  const all = await get("/episodes");
  expect(all.items.find((e) => e.runId === RUN_B)?.agentId).toBeNull();
  expect((await get("/episodes?agentId=8")).total).toBe(0);
});

it("rejects bad pages and filters", async () => {
  for (const q of [
    "page=0",
    "limit=0",
    "limit=101",
    "through=abc",
    "outcome=lost",
    "class=Z9",
    "runId=1",
    "source=x",
    "since=1y",
    "before=3",
    "attack=Z1-x",
  ])
    expect((await app.request(`/episodes?${q}`)).status, q).toBe(400);
  for (const q of ["status=lost", "hunter=0x1", "sort=size", "page=-1"])
    expect((await app.request(`/bounties?${q}`)).status, q).toBe(400);
});

it("numbers bounty pages, with filters and a reward sort", async () => {
  const hunter = (n: number) => `0x${String(n).repeat(40)}`;
  for (let id = 1; id <= 5; id++)
    await pg.db.pool.query(
      `INSERT INTO bounties(chain_id,submission_id,hunter,spec_uri,spec_yaml,spec,status,verdict)
       VALUES($1,$2,$3,'uri','yaml',$4,$5,$6)`,
      [
        chain.deployment.chainId,
        id,
        hunter(id % 2),
        JSON.stringify({
          id: `A${id}-b-${id}`,
          class: id === 5 ? "A1" : `A${id}`,
          title: `T${id}`,
          surfaces: ["dm"],
        }),
        id % 2 ? "accepted" : "rejected",
        JSON.stringify({ reward: String(id === 1 ? 2000 : id * 100) }),
      ],
    );
  type Bounties = { items: { submissionId: string }[]; page: number; pages: number; total: number };
  const page = async (q: string) =>
    (await (await app.request(`/bounties?${q}`)).json()) as Bounties;
  const ids = (b: Bounties) => b.items.map((x) => x.submissionId);

  expect(await page("limit=2")).toMatchObject({ page: 1, pages: 3, total: 5 });
  expect(ids(await page("limit=2"))).toEqual(["5", "4"]);
  expect(ids(await page("limit=2&page=3"))).toEqual(["1"]);
  expect(ids(await page("sort=reward"))).toEqual(["1", "5", "4", "3", "2"]);
  expect(ids(await page("status=accepted"))).toEqual(["5", "3", "1"]);
  expect(ids(await page("class=A1"))).toEqual(["5", "1"]);
  expect(ids(await page(`hunter=${hunter(0)}`))).toEqual(["4", "2"]);
  expect(await page("submission=3")).toMatchObject({ total: 1, items: [{ submissionId: "3" }] });
});

it("serves one episode with its ruling and detail, and older episodes without them", async () => {
  const detail = {
    task: "Buy 2000 tUSDG worth of tNVDA.",
    attack: { published: false, surfaces: ["dm"] },
    seen: false,
    steps: [{ step: 1, tool: "read_news", write: false, ok: true, breaches: [] }],
    guardBlocked: [],
    drained: [],
    stoppedBecause: "done",
  };
  await pg.db.publish("rating.episode", {
    runId: RUN_A,
    index: 0,
    total: 1,
    episode: {
      agent: "hardened-agent/scripted",
      attackId: "A6-held-out-1a2b3c4d",
      attackClass: "A6",
      durationMs: 1200,
      startedAt: "2026-10-07T14:58:12.000Z",
      verdict: { breached: false, totalLossUsd: 0, frozen: false },
      ruling: "unseen",
      detail,
    },
  });
  await episode(RUN_A, 1, "A2");
  const list = await get(`/episodes?runId=${RUN_A}`);
  const [legacy, withDetail] = list.items as unknown as {
    eventId: string;
    ruling: string | null;
  }[];
  expect(withDetail!.ruling).toBe("unseen");
  expect(legacy!.ruling).toBeNull();

  const one = await app.request(`/episodes/${withDetail!.eventId}`);
  expect(one.status).toBe(200);
  expect(await one.json()).toMatchObject({
    ruling: "unseen",
    agent: "hardened-agent/scripted",
    durationMs: 1200,
    detail,
  });
  const old = (await (await app.request(`/episodes/${legacy!.eventId}`)).json()) as {
    at: string;
  };
  expect(old).toMatchObject({ ruling: null, detail: null });
  // The episode's own start time when it has one; otherwise when it was recorded.
  expect((withDetail as unknown as { at: string }).at).toBe("2026-10-07T14:58:12.000Z");
  expect(Date.now() - Date.parse(old.at)).toBeLessThan(60_000);
  expect((await app.request("/episodes/999999999")).status).toBe(404);
  expect((await app.request("/episodes/abc")).status).toBe(400);
});

it("decides library or not from the published library, not the attack's id", async () => {
  // A bounty attack named freely, and a real library seed.
  await episode(RUN_B, 2, "A6", false, "A6-operator-social-broadcast-801");
  await episode(RUN_B, 3, "A2", false, "A2-fake-halt-news-001");
  const all = await get(`/episodes?runId=${RUN_B}`);
  const flag = (id: string) =>
    (all.items as unknown as { attackId: string; published: boolean | null }[]).find(
      (e) => e.attackId === id,
    )?.published;
  expect(flag("A6-operator-social-broadcast-801")).toBe(false);
  expect(flag("A2-fake-halt-news-001")).toBe(true);
  const ids = (p: EpisodesPage) =>
    (p.items as unknown as { attackId: string }[]).map((e) => e.attackId);
  const library = ids(await get(`/episodes?runId=${RUN_B}&source=library`));
  expect(library).toContain("A2-fake-halt-news-001");
  expect(library).not.toContain("A6-operator-social-broadcast-801");
  expect(ids(await get(`/episodes?runId=${RUN_B}&source=held-out`))).toEqual(
    expect.arrayContaining(["A6-operator-social-broadcast-801"]),
  );
  expect(ids(await get(`/episodes?runId=${RUN_B}&source=held-out`))).not.toContain(
    "A2-fake-halt-news-001",
  );
});
