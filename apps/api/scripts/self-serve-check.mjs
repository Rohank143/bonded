// Checks the self-serve loop on the hosted app (docs/AGENTS.md, "What works today"): a brand-new
// wallet onboards an agent, registers it for ratings, gets it rated by the hosted worker, buys
// cover with a quote that needs no operator token, simulates a breach as its own agent key, and
// waits for the hosted keeper's claim. Everything a tester does in the web app, scripted.
//
//   pnpm check:self-serve
//
// Sends real Robinhood testnet transactions. The deployer (DEPLOYER_PRIVATE_KEY in .env, never
// printed) only sends the new wallet a little test ETH for gas; every other step is the new
// wallet's own. Evidence goes to artifacts/self-serve-testnet.json.
import process from "node:process";
import console from "node:console";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { loadDotEnv } from "@bonded/arena";
import { connectChain } from "@bonded/keeper";
import {
  EVM_CHAINS,
  EvmMandate,
  bondedRegistryAbi,
  claimsEngineAbi,
  coverManagerAbi,
  demoRouterAbi,
  mandateHash,
  mandateVaultAbi,
  mandateVaultFactoryAbi,
  operatorBondAbi,
  parseEvmDeployment,
  quoteMessage,
  selfServeMessage,
  testTokenAbi,
  toEvmMandateParams,
} from "@bondedhq/shared";
import {
  encodeFunctionData,
  formatUnits,
  getAbiItem,
  parseEther,
  parseEventLogs,
  toFunctionSelector,
} from "viem";
import { generatePrivateKey } from "viem/accounts";
import { quoteApiUrl } from "../dist/demo-checks.js";

const { fetch } = globalThis;
loadDotEnv();
// After loading .env, so an endpoint set only there is used.
const API = quoteApiUrl(process.env);
const RPC = EVM_CHAINS.robinhoodTestnet.rpcUrl;
const EXPLORER = EVM_CHAINS.robinhoodTestnet.explorerUrl;
const usd = (n) => BigInt(n) * 1_000_000n;
const $ = (v) => `$${Number(formatUnits(v, 6)).toLocaleString("en-US")}`;
const tx = (h) => `${EXPLORER}/tx/${h}`;
const evidence = {
  network: "Robinhood Chain testnet",
  api: API,
  startedAt: new Date().toISOString(),
  steps: [],
};
const step = (name, data = {}) => {
  evidence.steps.push({ name, ...data });
  console.log(`✓ ${name}${data.tx ? `  ${tx(data.tx)}` : ""}`);
};

const d = parseEvmDeployment(await readFile("contracts/evm/deployments/46630.json", "utf8"), 46630);
const raw = process.env.DEPLOYER_PRIVATE_KEY;
if (!raw) throw new Error("DEPLOYER_PRIVATE_KEY is required (in .env), to send the new wallet gas");
const deployer = connectChain(d, RPC, raw.startsWith("0x") ? raw : `0x${raw}`);
const user = connectChain(d, RPC, generatePrivateKey());
const me = user.wallet.account.address;
const read = user.read;
evidence.wallet = me;
console.log(`New wallet ${me}`);

try {
  const gas = await deployer.wallet.sendTransaction({ to: me, value: parseEther("0.003") });
  await read.waitForTransactionReceipt({ hash: gas });
  step("Gas sent to the new wallet", { tx: gas });

  const send = async (address, abi, name, args) => {
    const hash = await user.send(address, abi, name, args);
    const receipt = await read.waitForTransactionReceipt({ hash, confirmations: 1 });
    return { hash, receipt };
  };
  const post = async (path, body) => {
    const r = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(`${path}: ${r.status} ${json.error ?? ""}`);
    return json;
  };

  // 1. Onboard, as the web app's "Onboard an agent" page does.
  const reg = await send(d.registry, bondedRegistryAbi, "register", [
    "ipfs://bonded/self-serve-check",
  ]);
  const agentId = parseEventLogs({
    abi: bondedRegistryAbi,
    logs: reg.receipt.logs,
    eventName: "Registered",
  })[0].args.agentId;
  evidence.agentId = agentId.toString();
  step(`Registered agent ${agentId}`, { tx: reg.hash });
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
    description: "Self-serve check: an agent onboarded by a script acting as the web app.",
  });
  const made = await send(d.factory, mandateVaultFactoryAbi, "createVault", [
    toEvmMandateParams(mandate),
    me,
    me,
    agentId,
    `Agent ${agentId} vault`,
    "BVLT",
  ]);
  const vault = parseEventLogs({
    abi: mandateVaultFactoryAbi,
    logs: made.receipt.logs,
    eventName: "VaultCreated",
  })[0].args.vault;
  evidence.vault = vault;
  step(`Created vault ${vault}`, { tx: made.hash });
  step("Minted test tUSDG", {
    tx: (await send(d.usdg, testTokenAbi, "faucet", [usd(54_000)])).hash,
  });
  await send(d.usdg, testTokenAbi, "approve", [d.bond, usd(4_000)]);
  step("Staked a 4,000 tUSDG bond", {
    tx: (await send(d.bond, operatorBondAbi, "stake", [agentId, usd(4_000)])).hash,
  });
  await send(d.usdg, testTokenAbi, "approve", [vault, usd(50_000)]);
  step("Deposited 50,000 tUSDG", {
    tx: (await send(vault, mandateVaultAbi, "deposit", [usd(50_000), me])).hash,
  });

  // 2. Register for ratings and ask for one, with signatures and no operator token.
  const now = () => Math.floor(Date.now() / 1000);
  let t = now();
  await post("/self/agents", {
    agentId: agentId.toString(),
    vault,
    kind: "partial",
    mandate,
    timestamp: t,
    signature: await user.wallet.signMessage({
      message: selfServeMessage({
        action: "register",
        chainId: d.chainId,
        agentId: agentId.toString(),
        vault,
        kind: "partial",
        mandateHash: mandateHash(mandate),
        timestamp: t,
      }),
    }),
  });
  step("Registered for ratings (signed)");
  t = now();
  const { runId } = await post(`/self/agents/${agentId}/rate`, {
    timestamp: t,
    signature: await user.wallet.signMessage({
      message: selfServeMessage({
        action: "rate",
        chainId: d.chainId,
        agentId: agentId.toString(),
        timestamp: t,
      }),
    }),
  });
  evidence.runId = runId;
  step(`Rating queued (run ${runId})`);
  let run;
  for (let i = 0; i < 180; i++) {
    run = await (await fetch(`${API}/arena/runs/${runId}`)).json();
    if (run.status === "done" || run.status === "failed") break;
    if (i % 6 === 0) console.log(`  rating ${run.status}…`);
    await delay(10_000);
  }
  if (run.status !== "done")
    throw new Error(`the rating ended ${run.status}: ${run.error ?? "timed out"}`);
  const score = await read.readContract({
    address: d.registry,
    abi: bondedRegistryAbi,
    functionName: "scoreOf",
    args: [agentId],
  });
  evidence.score = { score: score.score, expectedLossBps: score.expectedLossBps };
  step(`Rated: score ${score.score}, expected loss ${(score.expectedLossBps / 100).toFixed(2)}%`);

  // 3. Quote without a token, and buy cover.
  const quote = await post("/quotes", {
    agentId: agentId.toString(),
    vault,
    coverAmount: usd(20_000).toString(),
  });
  const bought = await send(d.coverManager, coverManagerAbi, "buyCover", [
    quoteMessage(quote.quote),
    quote.signature,
  ]);
  evidence.premiumRateBps = quote.quote.premiumRateBps;
  step(`Bought 20,000 cover at ${(quote.quote.premiumRateBps / 100).toFixed(2)}% a year`, {
    tx: bought.hash,
  });

  // 4. Simulate a breach as the agent key, and wait for the hosted keeper's claim.
  const start = await read.getBlockNumber();
  const breach = await send(vault, mandateVaultAbi, "execute", [
    d.usdg,
    encodeFunctionData({
      abi: testTokenAbi,
      functionName: "transfer",
      args: ["0x000000000000000000000000000000000000dEaD", usd(5_000)],
    }),
  ]);
  step("Simulated a 5,000 tUSDG breach", { tx: breach.hash });
  let paid;
  for (let i = 0; i < 60 && !paid; i++) {
    paid = (
      await read.getLogs({
        address: d.claimsEngine,
        event: getAbiItem({ abi: claimsEngineAbi, name: "ClaimPaid" }),
        args: { vault },
        fromBlock: start,
        toBlock: "latest",
        strict: true,
      })
    )[0];
    if (!paid) await delay(5000);
  }
  if (!paid) throw new Error("no claim within 5 minutes: check the keeper");
  evidence.claim = Object.fromEntries(
    Object.entries(paid.args).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]),
  );
  step(
    `Claim paid ${$(paid.args.payout)}: ${$(paid.args.fromBond)} from the bond, ${$(paid.args.fromPool)} from the pool`,
    {
      tx: paid.transactionHash,
    },
  );
  evidence.ok = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  console.error(`\nStopped: ${evidence.error}`);
  process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/self-serve-testnet.json", `${JSON.stringify(evidence, null, 2)}\n`);
  console.log("Evidence: artifacts/self-serve-testnet.json");
}
