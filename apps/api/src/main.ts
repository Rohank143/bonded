import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { loadDotEnv } from "@bonded/arena";
import { Database } from "@bonded/db";
import { Keeper, SolanaKeeper, connectChain, connectSolana, parseSolanaKey } from "@bonded/keeper";
import { parseEvmDeployment } from "@bonded/shared";
import { z } from "zod";
import { createApi } from "./index.js";
import { runTeeChecks, teeCheckInterval } from "./tee-watch.js";
import { agentConfig, workOne } from "./worker.js";
import { sentinelFromEnv } from "./sentinel.js";
import { workBountyOne } from "./bounty-worker.js";
import { Alerter, LoopHealth, Watchdog, telegramFromEnv } from "./alerts.js";

loadDotEnv();
const role = process.env.ROLE ?? "api";
// Operations alerts (docs/SERVICES.md "Alerts"); a no-op unless the Telegram secrets are set.
const alerter = new Alerter(telegramFromEnv(), { source: role });
/** Any error that would end the process: alert (bounded by a timeout), then exit for a restart. */
let crashing = false;
const crash = async (error: unknown) => {
  if (crashing) return;
  crashing = true;
  const kind = error instanceof Error ? error.name : "unknown error";
  console.error("service crashed:", kind);
  await Promise.race([
    alerter.alert("crash", `Crashed (${kind}). Railway restarts it up to 10 times.`),
    delay(5000),
  ]);
  process.exit(1);
};
process.on("uncaughtException", (error) => void crash(error));
/** Read a required variable without including its value in errors. */
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
/** Validate only the signing key required by the selected role. */
const key = (name: string) =>
  z
    .templateLiteral(["0x", z.string()])
    .refine((v) => /^0x[0-9a-fA-F]{64}$/.test(v))
    .parse(required(name));
const db = new Database(required("DATABASE_URL"));
await db.migrate();
if (role === "migrate") {
  await db.close();
} else {
  if (!["api", "keeper", "arena-worker", "all"].includes(role)) throw new Error("invalid ROLE");
  const deployment = parseEvmDeployment(await readFile(required("DEPLOYMENT_FILE"), "utf8"));
  const rpc = required("RPC_URL");
  const keeperKey = role === "keeper" || role === "all" ? key("KEEPER_KEY") : key("ATTESTER_KEY");
  const chain = connectChain(deployment, rpc, keeperKey);
  if ((await chain.read.getChainId()) !== deployment.chainId) throw new Error("RPC chain mismatch");
  if (process.env.AGENTS_FILE) {
    const configs = z
      .array(agentConfig)
      .parse(JSON.parse(await readFile(process.env.AGENTS_FILE, "utf8")));
    // Validate the entire file before changing the currently enabled set.
    if (configs.some((config) => config.mandate.chain.chainId !== deployment.chainId))
      throw new Error("agent chain mismatch");
    if (new Set(configs.map((config) => config.mandate.agentId)).size !== configs.length)
      throw new Error("duplicate configured agent");
    await db.reconcileAgents(
      deployment.chainId,
      configs.map((config) => ({ agentId: config.mandate.agentId, config })),
    );
  }

  const abort = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => abort.abort());
  const tasks: Promise<void>[] = [];
  /** Retry a role iteration until shutdown; an aborted delay exits promptly. */
  const loop = async (name: string, fn: () => Promise<unknown>, ms: number) => {
    const health = new LoopHealth(alerter, name);
    while (!abort.signal.aborted) {
      try {
        await fn();
        await health.succeeded();
      } catch (error) {
        console.error("service iteration failed; retrying");
        await health.failed(error);
      }
      await delay(ms, undefined, { signal: abort.signal }).catch(() => {});
    }
  };
  // Production Sentinel (SENTINEL_URL and LAYA_API_KEY), for checks and Sentinel-on ratings.
  const sentinel = sentinelFromEnv();
  let server: ReturnType<typeof serve> | undefined;
  let api: ReturnType<typeof createApi> | undefined;
  if (role === "api" || role === "all") {
    api = createApi({
      db,
      chain,
      attesterKey: key("ATTESTER_KEY"),
      apiToken: required("API_TOKEN"),
      webOrigins: (process.env.WEB_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
      // Sentinel checks for agents, when SENTINEL_URL is set (docs/SENTINEL.md).
      ...(sentinel ? { sentinel } : {}),
    });
    server = serve({
      fetch: api.fetch,
      port: z.coerce
        .number()
        .int()
        .min(1)
        .max(65535)
        .parse(process.env.PORT ?? 3000),
    });
  }
  if (role === "keeper" || role === "all") {
    const confirmations = z.coerce
      .number()
      .int()
      .min(0)
      .parse(process.env.KEEPER_CONFIRMATIONS ?? 5);
    // Premium accrual sends one transaction per active policy, so it runs hourly by default.
    const accrueEvery = z.coerce
      .number()
      .int()
      .min(5000)
      .parse(process.env.KEEPER_ACCRUE_MS ?? 3_600_000);
    const keeper = new Keeper(db, chain, BigInt(confirmations), accrueEvery);
    tasks.push(loop("The EVM keeper", () => keeper.tick(), 5000));
    // Solana claims (ADR-011), only when a Solana RPC and a fee-paying key are configured.
    const solanaRpc = process.env.SOLANA_RPC_URL;
    const solanaKey = process.env.SOLANA_KEEPER_KEY;
    if (solanaRpc && solanaKey) {
      const solana = new SolanaKeeper(db, connectSolana(solanaRpc, parseSolanaKey(solanaKey)));
      tasks.push(loop("The Solana keeper", () => solana.tick(), 15_000));
    }
    // Re-check TEE-hosted agents against their rated measurement. A stopped VM is just "unreachable".
    const teeEvery = teeCheckInterval.parse(process.env.TEE_CHECK_MS ?? 600_000);
    tasks.push(loop("TEE checks", () => runTeeChecks(db, chain), teeEvery));
    // The keeper role is always deployed once, so it owns event retention.
    const retentionDays = z.coerce
      .number()
      .int()
      .min(1)
      .parse(process.env.EVENTS_RETENTION_DAYS ?? 30);
    tasks.push(
      loop(
        "Event retention",
        async () => {
          const before = new Date(Date.now() - retentionDays * 86_400_000);
          await db.pruneEvents(before);
          await db.pruneSentinelChecks(before);
        },
        3_600_000,
      ),
    );
    // The keeper is deployed once, so it also watches for a lagging keeper, stuck claims and
    // failed ratings or accruals (issue #24).
    if (alerter.enabled) {
      const watchdog = new Watchdog(db, chain, alerter);
      tasks.push(loop("The alert watchdog", () => watchdog.check(), 60_000));
    }
  }
  if (role === "arena-worker" || role === "all") {
    // Separate account/nonce flow from the keeper, even in all mode.
    const worker = connectChain(deployment, rpc, key("ATTESTER_KEY"));
    tasks.push(
      loop(
        "The rating worker",
        () => workOne(db, worker, rpc, key("ATTESTER_KEY"), undefined, sentinel),
        1000,
      ),
    );
    // Error names only: messages can carry the RPC URL and its key.
    const bountyError = (e: unknown) =>
      console.error("bounty validation failed:", e instanceof Error ? e.name : "unknown error");
    tasks.push(loop("The bounty worker", () => workBountyOne(db, worker, rpc, bountyError), 5000));
  }
  console.info(`Bonded service ready: ${role}`);
  // Also the per-service test alert: each deploy or restart announces itself once.
  void alerter.alert("started", `Started on chain ${deployment.chainId}.`);
  if (!abort.signal.aborted)
    await new Promise<void>((resolve) =>
      abort.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  const httpClosed = new Promise<void>((resolve, reject) => {
    if (!server) return resolve();
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await api?.close();
  // Streams have released their listeners; reap sockets that became idle during that drain.
  if (server && "closeIdleConnections" in server) server.closeIdleConnections();
  await Promise.all([...tasks, httpClosed]);
  await db.close();
}
