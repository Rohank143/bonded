import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { loadDotEnv } from "@bonded/arena";
import { Database } from "@bonded/db";
import { Keeper, connectChain } from "@bonded/keeper";
import { parseEvmDeployment } from "@bonded/shared";
import { z } from "zod";
import { createApi } from "./index.js";
import { agentConfig, workOne } from "./worker.js";

loadDotEnv();
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
const role = process.env.ROLE ?? "api";
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
  const loop = async (fn: () => Promise<unknown>, ms: number) => {
    while (!abort.signal.aborted) {
      try {
        await fn();
      } catch {
        console.error("service iteration failed; retrying");
      }
      await delay(ms, undefined, { signal: abort.signal }).catch(() => {});
    }
  };
  let server: ReturnType<typeof serve> | undefined;
  let api: ReturnType<typeof createApi> | undefined;
  if (role === "api" || role === "all") {
    api = createApi({
      db,
      chain,
      attesterKey: key("ATTESTER_KEY"),
      apiToken: required("API_TOKEN"),
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
    const keeper = new Keeper(db, chain, BigInt(confirmations));
    tasks.push(loop(() => keeper.tick(), 5000));
    // The keeper role is always deployed once, so it owns event retention.
    const retentionDays = z.coerce
      .number()
      .int()
      .min(1)
      .parse(process.env.EVENTS_RETENTION_DAYS ?? 30);
    tasks.push(
      loop(() => db.pruneEvents(new Date(Date.now() - retentionDays * 86_400_000)), 3_600_000),
    );
  }
  if (role === "arena-worker" || role === "all") {
    // Separate account/nonce flow from the keeper, even in all mode.
    const worker = connectChain(deployment, rpc, key("ATTESTER_KEY"));
    tasks.push(loop(() => workOne(db, worker, rpc, key("ATTESTER_KEY")), 1000));
  }
  console.info(`Bonded service ready: ${role}`);
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
