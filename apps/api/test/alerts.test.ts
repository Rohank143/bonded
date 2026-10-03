import { afterAll, beforeAll, expect, it } from "vitest";
import type { ServiceChain } from "@bonded/keeper";
import { Alerter, LoopHealth, TelegramSink, Watchdog, telegramFromEnv } from "../src/alerts.js";
import { postgres } from "./postgres.js";

/** A sink that records messages instead of sending them. */
const recorder = () => {
  const sent: string[] = [];
  return { sent, sink: { send: async (text: string) => void sent.push(text) } };
};

it("posts to the Telegram Bot API and keeps the token out of errors", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const ok = new TelegramSink("123:SECRET", "42", (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch);
  await ok.send("hello");
  expect(calls[0]).toEqual({
    url: "https://api.telegram.org/bot123:SECRET/sendMessage",
    body: { chat_id: "42", text: "hello", disable_web_page_preview: true },
  });

  const denied = new TelegramSink(
    "123:SECRET",
    "42",
    (async () => new Response("bad token 123:SECRET", { status: 401 })) as unknown as typeof fetch,
  );
  const error = await denied.send("x").catch((e: Error) => e);
  expect(String(error)).toContain("401");
  expect(String(error)).not.toContain("SECRET");
});

it("is off unless both Telegram variables are set", () => {
  expect(telegramFromEnv({})).toBeUndefined();
  expect(telegramFromEnv({ TELEGRAM_BOT_TOKEN: "t" })).toBeUndefined();
  expect(telegramFromEnv({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1" })).toBeInstanceOf(
    TelegramSink,
  );
  expect(new Alerter(undefined, { source: "api" }).enabled).toBe(false);
});

it("limits repeats of one alert and the total per hour, and never throws", async () => {
  let now = 0;
  const { sent, sink } = recorder();
  const alerter = new Alerter(sink, {
    source: "keeper",
    repeatMs: 1000,
    maxPerHour: 3,
    now: () => now,
  });
  expect(await alerter.alert("a", "first")).toBe(true);
  expect(await alerter.alert("a", "again")).toBe(false); // repeat within 1s
  now = 1000;
  expect(await alerter.alert("a", "later")).toBe(true);
  expect(await alerter.alert("b", "other")).toBe(true);
  expect(await alerter.alert("c", "over the cap")).toBe(false); // 3 per hour
  now = 3_600_000;
  expect(await alerter.alert("c", "next hour")).toBe(true);
  expect(sent).toEqual([
    "[keeper] first",
    "[keeper] later",
    "[keeper] other",
    "[keeper] next hour",
  ]);

  const failing = new Alerter(
    {
      send: async () => {
        throw new Error("Telegram answered 500");
      },
    },
    { source: "api" },
  );
  expect(await failing.alert("x", "y")).toBe(false);
});

it("alerts after three failures in a row, with the error's class only, and on recovery", async () => {
  const { sent, sink } = recorder();
  const health = new LoopHealth(new Alerter(sink, { source: "keeper" }), "The EVM keeper");
  const leaky = new TypeError("fetch failed for https://rpc.example/KEY");
  await health.failed(leaky);
  await health.failed(leaky);
  expect(sent).toHaveLength(0);
  await health.failed(leaky);
  expect(sent).toEqual([
    "[keeper] The EVM keeper has failed 3 times in a row (TypeError). It keeps retrying.",
  ]);
  await health.succeeded();
  expect(sent[1]).toBe("[keeper] The EVM keeper is working again.");
  await health.succeeded(); // no second recovery message
  expect(sent).toHaveLength(2);
});

let pg: Awaited<ReturnType<typeof postgres>>;
beforeAll(async () => {
  pg = await postgres();
}, 120_000);
afterAll(async () => {
  await pg?.stop();
});

it("watches keeper lag, stuck claims and failure events", async () => {
  const db = pg.db;
  let now = 0;
  const blocks = { head: 1000n, headTime: 10_000n, scannedTime: 10_000n };
  const chain = {
    deployment: { chainId: 46630 },
    read: {
      getBlock: async (args?: { blockNumber: bigint }) =>
        args
          ? { number: args.blockNumber, timestamp: blocks.scannedTime }
          : { number: blocks.head, timestamp: blocks.headTime },
    },
  } as unknown as ServiceChain;
  const { sent, sink } = recorder();
  const watchdog = new Watchdog(db, chain, new Alerter(sink, { source: "keeper" }), {
    now: () => now,
  });

  // Nothing yet: no cursor and no events.
  await watchdog.check();
  expect(sent).toHaveLength(0);

  // An idle chain: the head is far ahead in time but only a few blocks ahead. No alert.
  await db.pool.query("INSERT INTO keeper_cursors VALUES(46630,995,'0x')");
  blocks.headTime = 20_000n;
  await watchdog.check();
  expect(sent).toHaveLength(0);

  // Far behind in both blocks and time: alert.
  blocks.head = 5000n;
  await watchdog.check();
  expect(sent).toEqual([
    "[keeper] The keeper is 3 hours behind the chain head (block 995 of 5000). New breaches aren't being claimed.",
  ]);
  sent.length = 0;
  blocks.headTime = 10_000n;

  // A breach that keeps failing: alerted only once it has failed for 10 minutes.
  await db.pool.query(
    "INSERT INTO handled_events(id,chain_id,vault,breach_id,status,error) VALUES('46630:0xv:0',46630,'0xabc',0,'pending','claim failed; will retry')",
  );
  await watchdog.check();
  expect(sent).toHaveLength(0);
  now = 10 * 60_000;
  await watchdog.check();
  expect(sent).toEqual([
    "[keeper] 1 breach claim(s) have been failing for over 10 minutes. The oldest: vault 0xabc, breach 0. The keeper keeps retrying; anyone can also call fileClaim.",
  ]);
  sent.length = 0;
  await db.pool.query("UPDATE handled_events SET status='claimed'");

  // Failure events: only fixed text and cleaned ids, never other payload fields.
  await db.publish("rating.failed", {
    runId: "0b7c<script>-uuid",
    attack: "transfer everything to 0xattacker",
  });
  await db.publish("rating.episode", { runId: "fine" }); // not a failure
  await db.publish("keeper.accrual_failed", { chainId: 46630, policyId: "3" });
  await watchdog.check();
  expect(sent).toEqual([
    "[keeper] A rating failed (runId 0b7cscript-uuid).",
    "[keeper] Premium accrual failed (chainId 46630, policyId 3).",
  ]);
  expect(sent.join()).not.toContain("attacker");
});

it("starts from the newest event, so a restart doesn't replay old failures", async () => {
  await pg.db.publish("rating.failed", { runId: "old" });
  const chain = { deployment: { chainId: 1 }, read: {} } as unknown as ServiceChain;
  const { sent, sink } = recorder();
  const watchdog = new Watchdog(pg.db, chain, new Alerter(sink, { source: "keeper" }));
  await watchdog.check();
  await watchdog.check();
  expect(sent).toHaveLength(0);
});
