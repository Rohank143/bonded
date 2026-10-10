import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { adoptDeployment, redeployedMessage } from "../src/deployment-guard.js";
import { postgres } from "./postgres.js";

let pg: Awaited<ReturnType<typeof postgres>>;
beforeAll(async () => {
  pg = await postgres();
}, 120_000);
afterAll(async () => {
  await pg?.stop();
});

const OLD = "0x35f6d30be731a639235ccad7abedda4d4be8d4f9";
const NEW = "0x691563A85D1D80f2891c0ecb2096E58CC4b4DFBA";
const preview = randomUUID();
const count = async (sql: string) => Number((await pg.db.pool.query(sql)).rows[0].n);

beforeEach(async () => {
  await pg.db.pool.query(
    `TRUNCATE deployments,agents,ratings,attestations,jobs,previews,keeper_cursors,keeper_policies,
     bounties,owner_notifications,runner_tokens,owner_sessions CASCADE`,
  );
});

/** A database holding the Sep 27 deployment's state on chain 46630, plus things to keep. */
async function seedOldDeployment() {
  const q = (sql: string, args: unknown[] = []) => pg.db.pool.query(sql, args);
  await q("INSERT INTO deployments(chain_id,registry) VALUES(46630,$1)", [OLD]);
  await q("INSERT INTO agents(id,chain_id,agent_id,config) VALUES('46630:2',46630,2,'{}')");
  await q("INSERT INTO agents(id,chain_id,agent_id,config) VALUES('421614:1',421614,1,'{}')");
  const rating = randomUUID();
  await q("INSERT INTO ratings(id,agent_id) VALUES($1,'46630:2')", [rating]);
  await q("INSERT INTO jobs(id) VALUES($1)", [rating]);
  await q("INSERT INTO attestations(id,agent_id,signed,tx_hash) VALUES($1,'46630:2','{}','0xtx')", [
    rating,
  ]);
  await q(
    `INSERT INTO previews(id,chain_id,owner,mode,connection,upgraded_to)
     VALUES($1,46630,'0xowner','tools','runner','46630:2')`,
    [preview],
  );
  await q("INSERT INTO ratings(id,preview_id) VALUES($1,$2)", [randomUUID(), preview]);
  await q("INSERT INTO keeper_cursors VALUES(46630,5,'0xhash',$1)", [OLD]);
  await q("INSERT INTO keeper_policies VALUES(46630,1,'0xvault')");
  await q(
    `INSERT INTO bounties(chain_id,submission_id,hunter,spec_uri,spec_yaml,spec)
     VALUES(46630,1,'0xhunter','ipfs://x','a: 1','{}')`,
  );
  for (const subject of ["46630:2", `preview:${preview}`])
    await q(
      `INSERT INTO owner_notifications(owner,type,dedupe_key,subject,payload)
       VALUES('0xowner','low_gas',$1,$1,'{}')`,
      [subject],
    );
  for (const agent of ["46630:2", `preview:${preview}`])
    await q(
      `INSERT INTO runner_tokens(id,agent_id,token_hash,created_by,signed_at)
       VALUES($1,$2,$3,'0xowner',1)`,
      [randomUUID(), agent, randomUUID()],
    );
  await q(
    `INSERT INTO owner_sessions(token_hash,chain_id,wallet,signature_hash,expires_at)
     VALUES('t',46630,'0xowner','s',now() + interval '1 day')`,
  );
}

it("records the deployment of a database that has none, and goes on", async () => {
  const lines: string[] = [];
  await adoptDeployment(pg.db, { chainId: 46630, registry: NEW }, "keeper", undefined, {
    log: (l) => lines.push(l),
  });
  expect(lines).toEqual([]);
  expect((await pg.db.pool.query("SELECT registry FROM deployments")).rows).toEqual([
    { registry: NEW.toLowerCase() },
  ]);
  // The same deployment again: nothing to do.
  expect(await pg.db.checkDeployment(46630, NEW)).toBeUndefined();
});

it("waits, without clearing anything, while the database holds another deployment", async () => {
  await seedOldDeployment();
  for (const [role, confirm] of [
    ["keeper", NEW], // only the api moves the database
    ["arena-worker", NEW],
    ["api", undefined], // not confirmed
    ["api", "0x6915"], // not this deployment's registry
    ["api", OLD],
  ] as const) {
    const lines: string[] = [];
    const abort = new AbortController();
    const waiting = adoptDeployment(pg.db, { chainId: 46630, registry: NEW }, role, confirm, {
      log: (l) => {
        lines.push(l);
        abort.abort();
      },
      retryMs: 5,
      signal: abort.signal,
    });
    await expect(waiting).rejects.toThrow(/abort/i);
    expect(lines).toEqual([redeployedMessage(46630, OLD, NEW)]);
  }
  expect(await count("SELECT count(*) AS n FROM agents")).toBe(2);
  expect(await count("SELECT count(*) AS n FROM ratings")).toBe(2);
});

it("on the operator's confirmation, clears the chain's old state and keeps the rest", async () => {
  await seedOldDeployment();
  const lines: string[] = [];
  await adoptDeployment(pg.db, { chainId: 46630, registry: NEW }, "api", ` ${NEW.toLowerCase()} `, {
    log: (l) => lines.push(l),
  });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(`Moved chain 46630 from the registry ${OLD} to ${NEW}`);
  expect(lines[0]).toMatch(/ratings 1, .*agents 1\./);

  // Cleared: the chain's agents and everything keyed by them or by its on-chain ids.
  expect((await pg.db.pool.query("SELECT id FROM agents")).rows).toEqual([{ id: "421614:1" }]);
  for (const table of ["attestations", "jobs", "keeper_cursors", "keeper_policies", "bounties"])
    expect(await count(`SELECT count(*) AS n FROM ${table}`)).toBe(0);
  // Kept: the preview, its rating, its token and notification, and the sign-in.
  expect((await pg.db.pool.query("SELECT upgraded_to FROM previews")).rows).toEqual([
    { upgraded_to: null },
  ]);
  expect(await count("SELECT count(*) AS n FROM ratings WHERE preview_id IS NOT NULL")).toBe(1);
  expect(await count("SELECT count(*) AS n FROM ratings")).toBe(1);
  expect((await pg.db.pool.query("SELECT agent_id FROM runner_tokens")).rows).toEqual([
    { agent_id: `preview:${preview}` },
  ]);
  expect((await pg.db.pool.query("SELECT subject FROM owner_notifications")).rows).toEqual([
    { subject: `preview:${preview}` },
  ]);
  expect(await count("SELECT count(*) AS n FROM owner_sessions")).toBe(1);
  expect(await pg.db.checkDeployment(46630, NEW)).toBeUndefined();

  // Once moved, the other services go on, and leaving ADOPT_DEPLOYMENT set does nothing.
  await adoptDeployment(pg.db, { chainId: 46630, registry: NEW }, "keeper", undefined);
  expect(await pg.db.adoptDeployment(46630, NEW)).toBeUndefined();
});
