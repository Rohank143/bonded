import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { ArenaGateway, loadDotEnv } from "@bonded/arena";
import { Database } from "@bonded/db";
import { Keeper, SolanaKeeper, connectChain, connectSolana, parseSolanaKey } from "@bonded/keeper";
import { parseEvmDeployment } from "@bonded/shared";
import { z } from "zod";
import { createApi } from "./index.js";
import { runTeeChecks, teeCheckInterval } from "./tee-watch.js";
import { agentConfig, workOne } from "./worker.js";
import { DEFAULT_REMOTE_POLICY, remoteQuota, type RemoteRatingPolicy } from "./remote-policy.js";
import { remoteRatingProblem } from "./eligibility.js";
import { sentinelFromEnv } from "./sentinel.js";
import { workBountyOne } from "./bounty-worker.js";
import { Alerter, LoopHealth, Watchdog, telegramFromEnv } from "./alerts.js";
import { renewExpiringScores } from "./live-loop.js";
import {
  OpenAICompatibleClient,
  bondedRegistryAbi,
  UNDERWRITING_COVER_CAP_USD,
  llmConfigFromEnv,
} from "@bonded/shared";
import { REMOTE_EPISODE_TIMEOUT_MS, gatewayAgents } from "./remote-agent.js";
import { DbRunnerAuth, RunnerPresenceWriter } from "./runners.js";

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
/** A cover cap in whole tUSDG from the environment, or its default. */
const usdCap = (name: string, fallback: number) =>
  z.coerce
    .number()
    .int()
    .min(0)
    .parse(process.env[name] ?? fallback);
/**
 * The gateway's public URL: GATEWAY_PUBLIC_URL, a full URL or a bare host (Railway's
 * RAILWAY_PUBLIC_DOMAIN of the arena-worker), which is taken as https.
 */
const gatewayUrl = () => {
  const value = process.env.GATEWAY_PUBLIC_URL?.trim();
  if (!value) return undefined;
  return z
    .url({ protocol: /^https?$/ })
    .parse(/^https?:\/\//.test(value) ? value : `https://${value}`);
};
/** Sizes, caps and budgets for operator-run agents' ratings, from the environment. */
const remotePolicy: RemoteRatingPolicy = (() => {
  const int = (name: string, fallback: number, min = 1) =>
    z.coerce
      .number()
      .int()
      .min(min)
      .parse(process.env[name] ?? fallback);
  const d = DEFAULT_REMOTE_POLICY;
  return {
    repeats: int("REMOTE_REPEATS", d.repeats),
    perOwnerDaily: int("REMOTE_RATINGS_PER_OWNER_DAILY", d.perOwnerDaily),
    perAgentDaily: int("REMOTE_RATINGS_PER_AGENT_DAILY", d.perAgentDaily),
    laneDaily: int("REMOTE_RATINGS_DAILY", d.laneDaily),
    episodeBudgetMs: int("REMOTE_EPISODE_BUDGET_MS", d.episodeBudgetMs, 1000),
    budgetCeilingMs: int("REMOTE_RATING_MAX_MS", d.budgetCeilingMs, 60_000),
  };
})();
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
  let gateway: ArenaGateway | undefined;
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
      // The Arena Gateway's public URL (the arena-worker's domain), for the runner command.
      ...(gatewayUrl() ? { gatewayUrl: gatewayUrl()! } : {}),
      // Underwriting policy for agents their operators run: total cover caps by binding.
      coverCaps: {
        declared: usdCap("DECLARED_COVER_CAP_USD", UNDERWRITING_COVER_CAP_USD.declared),
        tee: usdCap("TEE_COVER_CAP_USD", UNDERWRITING_COVER_CAP_USD.tee),
      },
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
    tasks.push(
      loop(
        "TEE checks",
        () => runTeeChecks(db, chain, undefined, { quota: remoteQuota(remotePolicy, Date.now()) }),
        teeEvery,
      ),
    );
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
    // The Arena Gateway (bring your own agent, docs/BRING-YOUR-OWN-AGENT.md): runners of agents
    // their operators run connect to it, and their agents reach their episodes through it. It
    // starts when GATEWAY_PORT is set; without it a remote agent's rating fails at once with
    // "gateway not available".
    const gatewayPort = process.env.GATEWAY_PORT
      ? z.coerce.number().int().min(1).max(65535).parse(process.env.GATEWAY_PORT)
      : undefined;
    if (gatewayPort) {
      const presence = new RunnerPresenceWriter(db, (line) => console.error(line));
      const publicUrl = gatewayUrl();
      gateway = new ArenaGateway({
        // A token stops working when the agent changes hands: the registry is checked too.
        tokens: new DbRunnerAuth(db, deployment.chainId, async (agentId) =>
          worker.read.readContract({
            address: deployment.registry,
            abi: bondedRegistryAbi,
            functionName: "agentOwner",
            args: [BigInt(agentId)],
          }),
        ),
        ...(publicUrl ? { publicUrl } : {}),
        onRunnerPresence: presence.onEvent,
        // Agent ids only; never a token or an episode's capability.
        log: (line) => console.info(`gateway: ${line}`),
      });
      await gateway.listen({ port: gatewayPort, host: "0.0.0.0" });
      console.info(`Arena Gateway listening on port ${gatewayPort}`);
    }
    // Held-out variants for remote ratings: drafted by a cheap model when a key is set (it is
    // advisory text; every variant is still checked against the undefended reference agent),
    // otherwise deterministic rewrites.
    const llmKey = process.env.LLM_API_KEY ?? process.env.OPENROUTER_API_KEY;
    const heldOut = {
      perClass: z.coerce
        .number()
        .int()
        .min(0)
        .max(5)
        .parse(process.env.HELD_OUT_FRESH_PER_CLASS ?? 1),
      ...(llmKey
        ? {
            llm: {
              client: new OpenAICompatibleClient(llmConfigFromEnv()),
              model: process.env.HELD_OUT_MODEL ?? "deepseek/deepseek-v4.1-flash",
              maxUsd: z.coerce
                .number()
                .min(0)
                .parse(process.env.HELD_OUT_MAX_USD ?? 0.25),
            },
          }
        : {}),
    };
    const ms = (name: string, fallback: number) =>
      z.coerce
        .number()
        .int()
        .min(1000)
        .parse(process.env[name] ?? fallback);
    if (gateway) {
      // Two lanes, each with its own lock: Bonded's own ratings never wait behind an operator's
      // agent, and remote ratings take turns by owner.
      const remote = gatewayAgents(gateway, {
        episodeTimeoutMs: ms("REMOTE_EPISODE_TIMEOUT_MS", REMOTE_EPISODE_TIMEOUT_MS),
      });
      const ownerOf = (agentId: string) =>
        worker.read.readContract({
          address: deployment.registry,
          abi: bondedRegistryAbi,
          functionName: "agentOwner",
          args: [BigInt(agentId)],
        });
      tasks.push(
        loop(
          "The rating worker",
          () =>
            workOne(db, worker, rpc, key("ATTESTER_KEY"), undefined, sentinel, {
              lane: "builtin",
            }),
          1000,
        ),
        loop(
          "The remote rating worker",
          () =>
            workOne(db, worker, rpc, key("ATTESTER_KEY"), undefined, sentinel, {
              lane: "remote",
              remote,
              heldOut,
              remotePolicy,
              ownerOf,
            }),
          1000,
        ),
      );
    } else
      tasks.push(
        loop(
          "The rating worker",
          () => workOne(db, worker, rpc, key("ATTESTER_KEY"), undefined, sentinel, { heldOut }),
          1000,
        ),
      );
    // Renew bring-your-own agents' scores before they lapse, while their runners are connected.
    tasks.push(
      loop(
        "Score renewals",
        () =>
          renewExpiringScores(db, deployment.chainId, undefined, {
            quota: remoteQuota(remotePolicy, Date.now()),
            problem: async (agentKey) => {
              const record = await db.agentRecord(agentKey);
              return remoteRatingProblem(worker, agentKey.split(":")[1]!, record?.owner ?? null);
            },
          }),
        z.coerce
          .number()
          .int()
          .min(60_000)
          .parse(process.env.RENEW_CHECK_MS ?? 600_000),
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
  await gateway?.close();
  // Streams have released their listeners; reap sockets that became idle during that drain.
  if (server && "closeIdleConnections" in server) server.closeIdleConnections();
  await Promise.all([...tasks, httpClosed]);
  await db.close();
}
