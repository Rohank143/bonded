import { afterAll, beforeAll, expect, it } from "vitest";
import { ANVIL_KEYS, Sandbox } from "@bonded/arena";
import { Keeper, connectChain, type ServiceChain } from "@bonded/keeper";
import {
  EvmMandate,
  bondedRegistryAbi,
  claimsEngineAbi,
  coverManagerAbi,
  coverPoolAbi,
  demoRouterAbi,
  mandateHash,
  mandateVaultAbi,
  mandateVaultFactoryAbi,
  operatorBondAbi,
  quoteMessage,
  selfServeMessage,
  testTokenAbi,
  toEvmMandateParams,
  type SignedQuote,
} from "@bondedhq/shared";
import {
  encodeFunctionData,
  getAbiItem,
  parseEther,
  parseEventLogs,
  toFunctionSelector,
  type Abi,
  type Address,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApi } from "../src/index.js";
import { workOne } from "../src/worker.js";
import { postgres } from "./postgres.js";

/**
 * The self-serve loop as a brand-new tester runs it from the web app, with no operator token:
 * onboard an agent, register it for ratings, get it rated, buy cover, simulate a breach with
 * their own wallet as the agent key, and see the keeper's claim pay.
 */
let pg: Awaited<ReturnType<typeof postgres>>;
let sandbox: Sandbox;
let operator: ServiceChain; // Bonded's side: attester, keeper, worker
let user: ServiceChain; // the tester's fresh wallet
let app: ReturnType<typeof createApi>;
const usd = (n: number) => BigInt(n) * 1_000_000n;

beforeAll(async () => {
  pg = await postgres();
  sandbox = await Sandbox.start();
  const d = sandbox.deployment;
  operator = connectChain(d, sandbox.rpcUrl, ANVIL_KEYS.deployer);
  // Underwriters fund the pool, as on testnet.
  await operator.send(d.usdg, testTokenAbi, "faucet", [usd(1_000_000)]);
  await operator.send(d.usdg, testTokenAbi, "approve", [d.pool, usd(1_000_000)]);
  await operator.send(d.pool, coverPoolAbi, "deposit", [
    usd(1_000_000),
    operator.wallet.account.address,
  ]);
  // A fresh tester wallet with some gas.
  const key = generatePrivateKey();
  await operator.read.request({
    method: "anvil_setBalance",
    params: [privateKeyToAccount(key).address, `0x${parseEther("1").toString(16)}`],
  } as never);
  user = connectChain(d, sandbox.rpcUrl, key);
  app = createApi({
    db: pg.db,
    chain: operator,
    attesterKey: ANVIL_KEYS.deployer,
    apiToken: "test-api-token-at-least-24-characters",
  });
}, 180_000);
afterAll(async () => {
  await app?.close();
  await sandbox?.stop();
  await pg?.stop();
});

const post = async (path: string, body: unknown) => {
  const r = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

it("a new wallet onboards, rates, insures and breaches an agent, and the claim pays", async () => {
  const d = sandbox.deployment;
  const me = user.wallet.account.address;
  const send = async (address: Address, abi: Abi, name: string, args: unknown[]) =>
    user.read.waitForTransactionReceipt({
      hash: await user.send(address, abi as never, name as never, args as never),
    });

  // 1. Onboard: register the agent and create its vault, with the tester's wallet as agent key.
  const registered = await send(d.registry, bondedRegistryAbi, "register", ["ipfs://x"]);
  const agentId = parseEventLogs({
    abi: bondedRegistryAbi,
    logs: registered.logs,
    eventName: "Registered",
  })[0]!.args.agentId;
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
    destinations: [me],
    limits: {
      maxTxNotionalUsd: 5000,
      maxDailyNotionalUsd: 25000,
      maxDrawdownBps: 1500,
      maxSlippageBps: 300,
    },
    freezeOnBreach: true,
    description: "An agent onboarded from the Bonded web app.",
  });
  const created = await send(d.factory, mandateVaultFactoryAbi, "createVault", [
    toEvmMandateParams(mandate),
    me,
    me,
    agentId,
    "v",
    "V",
  ]);
  const vault = parseEventLogs({
    abi: mandateVaultFactoryAbi,
    logs: created.logs,
    eventName: "VaultCreated",
  })[0]!.args.vault;
  await send(d.usdg, testTokenAbi, "faucet", [usd(54_000)]);
  await send(d.usdg, testTokenAbi, "approve", [d.bond, usd(4_000)]);
  await send(d.bond, operatorBondAbi, "stake", [agentId, usd(4_000)]);
  await send(d.usdg, testTokenAbi, "approve", [vault, usd(50_000)]);
  await send(vault, mandateVaultAbi, "deposit", [usd(50_000), me]);

  // 2. Register for ratings with a signature, as Agent A's design.
  const timestamp = Math.floor(Date.now() / 1000);
  const register = await post("/self/agents", {
    agentId: agentId.toString(),
    vault,
    kind: "partial",
    mandate,
    timestamp,
    signature: await user.wallet.signMessage({
      message: selfServeMessage({
        action: "register",
        chainId: d.chainId,
        agentId: agentId.toString(),
        vault,
        kind: "partial",
        mandateHash: mandateHash(mandate),
        timestamp,
      }),
    }),
  });
  expect(register.status).toBe(201);

  // 3. Ask for a rating; the worker rates it in a fork and posts the score.
  const rated = await post(`/self/agents/${agentId}/rate`, {
    timestamp,
    signature: await user.wallet.signMessage({
      message: selfServeMessage({
        action: "rate",
        chainId: d.chainId,
        agentId: agentId.toString(),
        timestamp,
      }),
    }),
  });
  expect(rated.status).toBe(202);
  for (let i = 0; i < 6; i++)
    await operator.read.request({ method: "evm_mine", params: [] } as never);
  // Run the worker until the rating is over, as the service does: a failed attempt is retried
  // (up to the job's three attempts), so the test waits on the rating's own status, not on one
  // pass of the worker, and says why if it never posts.
  const runId = rated.body.runId as string;
  const errors: string[] = [];
  let status = "queued";
  for (let attempt = 0; attempt < 3 && status !== "done" && status !== "failed"; attempt++) {
    await workOne(pg.db, operator, sandbox.rpcUrl, ANVIL_KEYS.deployer, (e) =>
      errors.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e)),
    );
    const row = (await pg.db.pool.query("SELECT status FROM ratings WHERE id=$1", [runId]))
      .rows[0] as { status: string };
    status = row.status;
    // A retry waits 30 s in the service; here it may start at once.
    if (status === "queued")
      await pg.db.pool.query("UPDATE jobs SET available_at=now() WHERE id=$1", [runId]);
  }
  expect(status, errors.join("\n")).toBe("done");
  const score = await operator.read.readContract({
    address: d.registry,
    abi: bondedRegistryAbi,
    functionName: "scoreOf",
    args: [agentId],
  });
  expect(score.score).toBe(49); // Agent A's design: insurable (BB), breached only by A5

  // 4. Quote without the operator token, and buy cover from the tester's wallet.
  const quote = await post("/quotes", {
    agentId: agentId.toString(),
    vault,
    coverAmount: usd(20_000).toString(),
  });
  expect(quote.status).toBe(201);
  const signed = quote.body as unknown as SignedQuote;
  await send(d.coverManager, coverManagerAbi, "buyCover", [
    quoteMessage(signed.quote),
    signed.signature,
  ]);

  // 5. Simulate a breach: the tester's wallet is the agent key.
  const start = await operator.read.getBlockNumber();
  await send(vault, mandateVaultAbi, "execute", [
    d.usdg,
    encodeFunctionData({
      abi: testTokenAbi,
      functionName: "transfer",
      args: ["0x000000000000000000000000000000000000dEaD", usd(5_000)],
    }),
  ]);
  expect(
    await operator.read.readContract({
      address: vault,
      abi: mandateVaultAbi,
      functionName: "frozen",
    }),
  ).toBe(true);

  // 6. The keeper files the claim: bond first, then the pool.
  const keeper = new Keeper(pg.db, { ...operator, deployment: { ...d, deployedAtBlock: 0 } }, 0n);
  let paid;
  for (let i = 0; i < 20 && !paid; i++) {
    await keeper.tick();
    paid = (
      await operator.read.getLogs({
        address: d.claimsEngine,
        event: getAbiItem({ abi: claimsEngineAbi, name: "ClaimPaid" }),
        args: { vault },
        fromBlock: start,
        toBlock: "latest",
        strict: true,
      })
    )[0];
  }
  expect(paid?.args.payout).toBe(usd(4_500));
  expect(paid?.args.fromBond).toBe(usd(4_000));
  expect(paid?.args.fromPool).toBe(usd(500));
  // The whole library, S1, six controls and the benign twins: near ten minutes alongside the
  // rest of the suite.
}, 900_000);
