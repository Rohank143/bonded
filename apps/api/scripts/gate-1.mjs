import process from "node:process";
import console from "node:console";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import EmbeddedPostgres from "embedded-postgres";
import { Sandbox, ANVIL_KEYS, loadDotEnv } from "@bonded/arena";
import { Database, json } from "@bonded/db";
import { Keeper, connectChain } from "@bonded/keeper";
import {
  EvmMandate,
  parseEvmDeployment,
  toEvmMandateParams,
  bondedRegistryAbi,
  mandateVaultFactoryAbi,
  mandateVaultAbi,
  testTokenAbi,
  coverManagerAbi,
  operatorBondAbi,
  coverPoolAbi,
  demoRouterAbi,
  quoteMessage,
} from "@bonded/shared";
import {
  getAbiItem,
  toFunctionSelector,
  encodeFunctionData,
  parseEventLogs,
  keccak256,
  stringToBytes,
} from "viem";
import { createApi } from "../dist/index.js";
import { workOne } from "../dist/worker.js";

const local = process.argv.includes("--local");
if (!local && !process.argv.includes("--broadcast"))
  throw new Error("Choose --local or --broadcast (Robinhood testnet only)");
const output =
  process.env.GATE_OUTPUT ??
  (local ? "artifacts/gate-1-local.json" : "artifacts/gate-1-testnet.json");
let sandbox, pg, db, directory;
const evidence = {
  network: local ? "Anvil" : "Robinhood Chain testnet",
  transactions: [],
  startedAt: new Date().toISOString(),
};
try {
  if (local) sandbox = await Sandbox.start();
  else loadDotEnv();
  const d = local
    ? sandbox.deployment
    : parseEvmDeployment(await readFile("contracts/evm/deployments/46630.json", "utf8"), 46630);
  const rpc = local ? sandbox.rpcUrl : "https://rpc.testnet.chain.robinhood.com/rpc";
  const raw = local ? ANVIL_KEYS.deployer : process.env.DEPLOYER_PRIVATE_KEY;
  if (!raw) throw new Error("DEPLOYER_PRIVATE_KEY required");
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  const base = connectChain(d, rpc, key);
  if ((await base.read.getChainId()) !== d.chainId) throw new Error("RPC chain mismatch");
  if (!local && d.chainId !== 46630) throw new Error("testnet only");
  const start = await base.read.getBlockNumber({ cacheTime: 0 });
  const account = base.wallet.account.address;
  if (
    !(await base.read.readContract({
      address: d.registry,
      abi: bondedRegistryAbi,
      functionName: "isAttester",
      args: [account],
    }))
  )
    throw new Error("deployer is not an attester");
  const waiting = await base.read.readContract({
    address: d.coverManager,
    abi: coverManagerAbi,
    functionName: "waitingPeriod",
  });
  if (waiting !== 0n) throw new Error("demo requires an existing zero-waiting-period deployment");
  console.log(`Starting ${evidence.network}; sender ${account}`);
  const send = async (address, abi, name, args) => {
    const hash = await base.send(address, abi, name, args);
    evidence.transactions.push({ step: name, hash });
    console.log(`${name}: ${hash}`);
    return base.read.waitForTransactionReceipt({ hash, confirmations: local ? 1 : 2 });
  };
  const registered = await send(d.registry, bondedRegistryAbi, "register", [
    "ipfs://bonded/gate-1/scripted-hardened",
  ]);
  const agentId = parseEventLogs({
    abi: bondedRegistryAbi,
    logs: registered.logs,
    eventName: "Registered",
  })[0].args.agentId;
  const mandate = EvmMandate.parse({
    version: 1,
    chain: { family: "evm", chainId: d.chainId },
    agentId: agentId.toString(),
    mode: "monitor",
    baseAsset: d.usdg,
    assets: [d.usdg, d.tsla, d.amzn, d.nvda],
    targets: [
      {
        address: d.router,
        selectors: [toFunctionSelector(getAbiItem({ abi: demoRouterAbi, name: "swap" }))],
      },
    ],
    destinations: [],
    limits: {
      maxTxNotionalUsd: 5000,
      maxDailyNotionalUsd: 25000,
      maxDrawdownBps: 1500,
      maxSlippageBps: 300,
    },
    freezeOnBreach: true,
    description: "Gate 1 scripted hardened agent; controlled breach injection after rating.",
  });
  const created = await send(d.factory, mandateVaultFactoryAbi, "createVault", [
    toEvmMandateParams(mandate),
    account,
    account,
    agentId,
    "Gate 1 Vault",
    "GATE1",
  ]);
  const vault = parseEventLogs({
    abi: mandateVaultFactoryAbi,
    logs: created.logs,
    eventName: "VaultCreated",
  })[0].args.vault;
  const usd = (n) => BigInt(n) * 1000000n;
  await send(d.usdg, testTokenAbi, "faucet", [usd(560000)]);
  await send(d.usdg, testTokenAbi, "approve", [d.pool, usd(500000)]);
  await send(d.pool, coverPoolAbi, "deposit", [usd(500000), account]);
  await send(d.usdg, testTokenAbi, "approve", [d.bond, usd(10000)]);
  await send(d.bond, operatorBondAbi, "stake", [agentId, usd(10000)]);
  await send(d.usdg, testTokenAbi, "approve", [vault, usd(50000)]);
  await send(vault, mandateVaultAbi, "deposit", [usd(50000), account]);
  directory = await mkdtemp(join(tmpdir(), "bonded-gate-"));
  const port = await new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
  pg = new EmbeddedPostgres({
    databaseDir: join(directory, "db"),
    user: "postgres",
    password: "test",
    port,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  db = new Database(`postgres://postgres:test@127.0.0.1:${port}/postgres`);
  await db.migrate();
  const id = `${d.chainId}:${agentId}`;
  await db.pool.query("INSERT INTO agents VALUES($1,$2,$3,$4)", [
    id,
    d.chainId,
    agentId.toString(),
    json({
      kind: "hardened",
      mandate,
      codeHash: keccak256(stringToBytes("bonded/scripted-hardened/v0")),
    }),
  ]);
  const token = randomBytes(24).toString("hex");
  const app = createApi({ db, chain: base, attesterKey: key, apiToken: token });
  const post = async (path, body) => {
    const r = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: json(body),
    });
    const data = await r.json();
    if (r.status >= 400) throw new Error(`${path}: ${json(data)}`);
    return data;
  };
  const { runId } = await post("/arena/runs", { agentId: agentId.toString() });
  evidence.runId = runId;
  evidence.agentId = agentId.toString();
  evidence.vault = vault;
  // Permit the fork's five-block lag to include the newly registered agent and market state.
  if (!local) await delay(3000);
  else for (let i = 0; i < 6; i++) await base.read.request({ method: "evm_mine", params: [] });
  console.log("Running 42 sandbox episodes");
  await workOne(db, base, rpc, key, (e) =>
    console.error(e instanceof Error ? e.message : "worker failed"),
  );
  const rating = (await db.pool.query("SELECT * FROM ratings WHERE id=$1", [runId])).rows[0];
  if (rating.status !== "done") throw new Error(`rating status: ${rating.status}`);
  const attestation = (await db.pool.query("SELECT * FROM attestations WHERE id=$1", [runId]))
    .rows[0];
  evidence.transactions.push({ step: "postScore", hash: attestation.tx_hash });
  evidence.report = rating.report;
  evidence.attestation = attestation.signed;
  evidence.episodeEvents = (
    await db.pool.query("SELECT count(*) FROM events WHERE topic='rating.episode'")
  ).rows[0].count;
  const signed = await post("/quotes", {
    agentId: agentId.toString(),
    vault,
    coverAmount: usd(20000).toString(),
  });
  evidence.quote = signed;
  await send(d.coverManager, coverManagerAbi, "buyCover", [
    quoteMessage(signed.quote),
    signed.signature,
  ]);
  // Deliberate out-of-mandate transfer tests payout plumbing; it is not a claimed jailbreak.
  await send(vault, mandateVaultAbi, "execute", [
    d.usdg,
    encodeFunctionData({
      abi: testTokenAbi,
      functionName: "transfer",
      args: ["0x0000000000000000000000000000000000000bad", usd(1000)],
    }),
  ]);
  const balance = () =>
    base.read.readContract({
      address: d.usdg,
      abi: testTokenAbi,
      functionName: "balanceOf",
      args: [vault],
    });
  const before = await balance();
  const keeper = new Keeper(
    db,
    connectChain({ ...d, deployedAtBlock: Number(start) }, rpc, key),
    local ? 0n : 5n,
  );
  for (let i = 0; i < 60; i++) {
    await keeper.tick();
    if ((await db.pool.query("SELECT 1 FROM handled_events WHERE status='claimed'")).rowCount)
      break;
    await delay(1000);
  }
  const claims = await db.pool.query("SELECT * FROM handled_events WHERE status='claimed'");
  if (!claims.rowCount) throw new Error("keeper did not claim within deadline");
  for (const claim of claims.rows)
    evidence.transactions.push({ step: "fileClaim (keeper)", hash: claim.tx_hash });
  const after = await balance();
  if (after <= before) throw new Error("payout did not increase vault balance");
  evidence.vaultBefore = before.toString();
  evidence.vaultAfter = after.toString();
  evidence.payoutIncrease = (after - before).toString();
  evidence.health = await (await app.request("/health")).json();
  await new Keeper(
    db,
    connectChain({ ...d, deployedAtBlock: Number(start) }, rpc, key),
    local ? 0n : 5n,
  ).tick();
  if ((await db.pool.query("SELECT * FROM events WHERE topic='claim.paid'")).rowCount !== 1)
    throw new Error("duplicate claim event after restart");
  evidence.restartVerified = true;
  evidence.completedAt = new Date().toISOString();
  console.log(`Gate 1 passed; payout increase ${evidence.payoutIncrease}`);
} finally {
  await mkdir("artifacts", { recursive: true });
  await writeFile(output, `${json(evidence)}\n`);
  await db?.close();
  await pg?.stop();
  await sandbox?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
}
