import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { loadDotEnv } from "@bonded/arena";
import { Database, json } from "@bonded/db";
import { Keeper, connectChain } from "@bonded/keeper";
import { parseEvmDeployment } from "@bonded/shared";
import { z } from "zod";
import { createApi } from "./index.js";
import { agentConfig, workOne } from "./worker.js";

loadDotEnv();
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
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
  const keeperKey = role === "api" ? key("ATTESTER_KEY") : key("KEEPER_KEY");
  const chain = connectChain(deployment, rpc, keeperKey);
  if ((await chain.read.getChainId()) !== deployment.chainId) throw new Error("RPC chain mismatch");
  if (process.env.AGENTS_FILE) {
    const configs = z
      .array(agentConfig)
      .parse(JSON.parse(await readFile(process.env.AGENTS_FILE, "utf8")));
    for (const config of configs) {
      if (config.mandate.chain.chainId !== deployment.chainId)
        throw new Error("agent chain mismatch");
      await db.pool.query(
        "INSERT INTO agents(id,chain_id,agent_id,config) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET config=$4",
        [
          `${deployment.chainId}:${config.mandate.agentId}`,
          deployment.chainId,
          config.mandate.agentId,
          json(config),
        ],
      );
    }
  }
  const abort = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => abort.abort());
  const tasks: Promise<void>[] = [];
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
  if (role === "api" || role === "all")
    server = serve({
      fetch: createApi({
        db,
        chain,
        attesterKey: key("ATTESTER_KEY"),
        apiToken: required("API_TOKEN"),
      }).fetch,
      port: z.coerce
        .number()
        .int()
        .min(1)
        .max(65535)
        .parse(process.env.PORT ?? 3000),
    });
  if (role === "keeper" || role === "all") {
    const confirmations = z.coerce
      .number()
      .int()
      .min(0)
      .parse(process.env.KEEPER_CONFIRMATIONS ?? 5);
    const keeper = new Keeper(db, chain, BigInt(confirmations));
    tasks.push(loop(() => keeper.tick(), 5000));
  }
  if (role === "arena-worker" || role === "all") {
    // Separate account/nonce flow from the keeper, even in all mode.
    const worker = connectChain(deployment, rpc, key("ATTESTER_KEY"));
    tasks.push(loop(() => workOne(db, worker, rpc, key("ATTESTER_KEY")), 1000));
  }
  if (!abort.signal.aborted)
    await new Promise<void>((resolve) =>
      abort.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  server?.close();
  await Promise.all(tasks);
  await db.close();
}
