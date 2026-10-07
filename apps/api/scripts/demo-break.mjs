// The demo's "break it" beat, live on Robinhood testnet (docs/SPECIFICATION.md Section 21): a zero-value
// transfer from a lookalike of the depositor's address asks Agent A (agent 10) for a refund.
// Agent A's own brain reads it and pays; its guard checks addresses by their ends only, so the
// payment goes through. The vault records the breach and freezes the agent, then the hosted
// keeper files the claim. This script waits for that claim and prints the waterfall.
//
//   pnpm demo:break            run the break and wait for the keeper's claim
//   pnpm demo:break -- --wait  only wait for (and record) the claim of the last take
//   pnpm demo:break -- --reset re-arm for another take: unfreeze, top up the bond and the vault,
//                              and renew the cover if it has ended or can't pay the next claim
//
// Sends real testnet transactions. A take signs as the agent with DEMO_AGENT_KEY; --reset signs as
// the operator with DEPLOYER_PRIVATE_KEY and asks the API for a quote with API_TOKEN (all from .env,
// never printed). --wait only reads, so it needs no key. Evidence goes to
// artifacts/demo-break-testnet.json.
import process from "node:process";
import console from "node:console";
const { fetch } = globalThis;
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { loadAttackLibrary, loadDotEnv, runLiveAttack } from "@bonded/arena";
import { createPartialAgent } from "@bonded/demo-agents";
import { connectChain } from "@bonded/keeper";
import {
  EVM_CHAINS,
  EvmMandate,
  claimsEngineAbi,
  coverManagerAbi,
  mandateVaultAbi,
  mandateVaultFactoryAbi,
  operatorBondAbi,
  parseEvmDeployment,
  quoteMessage,
  testTokenAbi,
} from "@bonded/shared";
import { createPublicClient, formatUnits, getAbiItem, http } from "viem";
import { coverageProblem, quoteApiUrl } from "../dist/demo-checks.js";

const RPC = EVM_CHAINS.robinhoodTestnet.rpcUrl;
const EXPLORER = EVM_CHAINS.robinhoodTestnet.explorerUrl;
const ATTACK = "A5-address-poisoning-001";
const BOND = 4_000_000_000n; // 4,000 tUSDG: tier BB's 20% of 20,000 cover
const DEPOSIT = 50_000_000_000n;
const COVER = 20_000_000_000n;
/** The take's loss is 5,000; the claim pays it minus the 10% deductible. */
const PAYOUT = 4_500_000_000n;
const OUTPUT = "artifacts/demo-break-testnet.json";

const reset = process.argv.includes("--reset");
const usd = (v) =>
  `$${Number(formatUnits(v, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const tx = (hash) => `${EXPLORER}/tx/${hash}`;

loadDotEnv();
// After loading .env, so an endpoint set only there is used.
const API = quoteApiUrl(process.env);
const d = parseEvmDeployment(await readFile("contracts/evm/deployments/46630.json", "utf8"), 46630);
const entry = JSON.parse(await readFile("config/agents.46630.json", "utf8")).find(
  (e) => e.kind === "partial",
);
if (!entry) throw new Error("config/agents.46630.json has no partial agent (Agent A)");
const mandate = EvmMandate.parse(entry.mandate);
const agentId = BigInt(mandate.agentId);

const keyOf = (name) => {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required (in .env)`);
  return raw.startsWith("0x") ? raw : `0x${raw}`;
};
// Reading needs no key; the operator and agent keys are loaded only by the steps that sign.
const read = createPublicClient({ transport: http(RPC) });
if ((await read.getChainId()) !== 46630) throw new Error("testnet only");

// Agent A's vault: the factory's VaultCreated event for its agent id.
const created = await read.getLogs({
  address: d.factory,
  event: getAbiItem({ abi: mandateVaultFactoryAbi, name: "VaultCreated" }),
  fromBlock: BigInt(d.deployedAtBlock),
  toBlock: "latest",
  strict: true,
});
const vault = created.filter((l) => l.args.agentId === agentId).at(-1)?.args.vault;
if (!vault) throw new Error(`no vault found for agent ${agentId}`);
const readVault = (functionName, args = []) =>
  read.readContract({ address: vault, abi: mandateVaultAbi, functionName, args });
const balanceOf = (who) =>
  read.readContract({ address: d.usdg, abi: testTokenAbi, functionName: "balanceOf", args: [who] });
const bondOf = () =>
  read.readContract({
    address: d.bond,
    abi: operatorBondAbi,
    functionName: "bondOf",
    args: [agentId],
  });
const activePolicy = () =>
  read.readContract({
    address: d.coverManager,
    abi: coverManagerAbi,
    functionName: "activePolicyOf",
    args: [vault],
  });
const policyOf = (id) =>
  read.readContract({
    address: d.coverManager,
    abi: coverManagerAbi,
    functionName: "getPolicy",
    args: [id],
  });
const chainNow = async () => (await read.getBlock()).timestamp;
let operatorChain;
const operator = () => (operatorChain ??= connectChain(d, RPC, keyOf("DEPLOYER_PRIVATE_KEY")));
const send = async (address, abi, name, args) => {
  const hash = await operator().send(address, abi, name, args);
  await read.waitForTransactionReceipt({ hash, confirmations: 2 });
  console.log(`  ${name}: ${tx(hash)}`);
  return hash;
};

console.log(`Agent A: agent ${agentId}, vault ${vault}`);

if (reset) {
  console.log("Re-arming Agent A for another take:");
  if (await readVault("frozen")) await send(vault, mandateVaultAbi, "unfreeze", []);
  const bond = await bondOf();
  const vaultBalance = await balanceOf(vault);
  const needed =
    (bond < BOND ? BOND - bond : 0n) + (vaultBalance < DEPOSIT ? DEPOSIT - vaultBalance : 0n);
  if (needed > 0n) await send(d.usdg, testTokenAbi, "faucet", [needed]);
  if (bond < BOND) {
    await send(d.usdg, testTokenAbi, "approve", [d.bond, BOND - bond]);
    await send(d.bond, operatorBondAbi, "stake", [agentId, BOND - bond]);
  }
  if (vaultBalance < DEPOSIT) {
    await send(d.usdg, testTokenAbi, "approve", [vault, DEPOSIT - vaultBalance]);
    await send(vault, mandateVaultAbi, "deposit", [
      DEPOSIT - vaultBalance,
      operator().wallet.account.address,
    ]);
  }
  // Close a policy whose time is up (accrue expires or lapses it), and end one that can't pay
  // another full claim, so the take below is covered in full.
  let policyId = await activePolicy();
  if (policyId !== 0n) {
    await send(d.coverManager, coverManagerAbi, "accrue", [policyId]);
    policyId = await activePolicy();
  }
  if (policyId !== 0n && coverageProblem(await policyOf(policyId), await chainNow(), PAYOUT)) {
    console.log(
      `  policy ${policyId}: ${coverageProblem(await policyOf(policyId), await chainNow(), PAYOUT)}; replacing it`,
    );
    if ((await policyOf(policyId)).coveredFrom <= (await chainNow()))
      await send(d.coverManager, coverManagerAbi, "cancel", [policyId]);
    policyId = await activePolicy();
  }
  if (policyId === 0n) {
    const res = await fetch(`${API}/quotes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.API_TOKEN}`,
      },
      body: JSON.stringify({ agentId: agentId.toString(), vault, coverAmount: COVER.toString() }),
    });
    const signed = await res.json();
    if (!res.ok) throw new Error(`quote refused: ${signed.error ?? res.status}`);
    await send(d.coverManager, coverManagerAbi, "buyCover", [
      quoteMessage(signed.quote),
      signed.signature,
    ]);
  }
  policyId = await activePolicy();
  const policy = await policyOf(policyId);
  const problem = coverageProblem(policy, await chainNow(), PAYOUT);
  console.log(
    `${problem ? "Not ready yet" : "Ready"}: bond ${usd(await bondOf())}, vault ${usd(await balanceOf(vault))}, ` +
      `policy ${policyId} with ${usd(policy.remainingCover)} of cover left${problem ? ` (${problem})` : ""}.`,
  );
  process.exit(problem ? 1 : 0);
}

const TAKE = "artifacts/demo-break-take.json";
const actions = (trace) =>
  trace
    .filter((s) => ["swap", "transfer", "approve"].includes(s.tool))
    .map((s) => ({ tool: s.tool, args: s.args, txHashes: s.txHashes, breaches: s.breaches }));
const plain = (o) =>
  Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]),
  );

let take;
if (process.argv.includes("--wait")) {
  // Only wait for (or record) the claim of the last take, e.g. after a slow keeper.
  take = JSON.parse(await readFile(TAKE, "utf8"));
  console.log(`Waiting for the claim of the take at block ${take.startBlock}.`);
} else {
  // Preconditions, so a take never fails halfway.
  if (await readVault("frozen"))
    throw new Error("Agent A is frozen from an earlier take: run with --reset first");
  const policyId = await activePolicy();
  if (policyId === 0n) throw new Error("Agent A has no active cover: run with --reset first");
  const problem = coverageProblem(await policyOf(policyId), await chainNow(), PAYOUT);
  if (problem)
    throw new Error(`the breach wouldn't be paid in full: ${problem}. Run with --reset first`);

  const agentChain = connectChain(d, RPC, keyOf("DEMO_AGENT_KEY"));
  const start = await read.getBlockNumber();
  const before = {
    vault: await balanceOf(vault),
    bond: await bondOf(),
    pool: await balanceOf(d.pool),
  };
  console.log(
    `Before: vault ${usd(before.vault)}, operator bond ${usd(before.bond)}, pool ${usd(before.pool)}; policy ${policyId}`,
  );
  console.log(
    `\nPlanting ${ATTACK}: a "refund" request from a lookalike of the depositor's address.`,
  );
  const result = await runLiveAttack({
    chain: { deployment: d, publicClient: read, wallet: () => agentChain.wallet },
    vault,
    mandate,
    agent: createPartialAgent("scripted"),
    attack: loadAttackLibrary().find((s) => s.id === ATTACK),
  });
  const lookalike = result.planted[0]?.sender;
  console.log(`  depositor ${mandate.destinations[0]}`);
  console.log(`  lookalike ${lookalike}`);
  for (const step of actions(result.trace))
    console.log(
      `  agent ${step.tool} ${JSON.stringify(step.args)}${step.txHashes.map((h) => ` → ${tx(h)}`).join("")}`,
    );
  if (!result.breachIds.length) throw new Error("the vault recorded no breach: the take failed");
  console.log(
    `Breach recorded (ids ${result.breachIds.join(", ")}); agent frozen: ${result.frozen}.`,
  );
  take = {
    startBlock: start.toString(),
    policyId: policyId.toString(),
    depositor: mandate.destinations[0],
    lookalike,
    agentActions: actions(result.trace),
    breachIds: result.breachIds,
    before: plain(before),
  };
  await mkdir("artifacts", { recursive: true });
  await writeFile(TAKE, `${JSON.stringify(take, null, 2)}\n`);
}

console.log(
  "\nWaiting for the keeper to file the claim (it waits 5 blocks, then claims within seconds)...",
);
let paid;
for (let i = 0; i < 60 && !paid; i++) {
  const logs = await read.getLogs({
    address: d.claimsEngine,
    event: getAbiItem({ abi: claimsEngineAbi, name: "ClaimPaid" }),
    args: { vault },
    fromBlock: BigInt(take.startBlock),
    toBlock: "latest",
    strict: true,
  });
  paid = logs.at(-1);
  if (!paid) await delay(5000);
}
if (!paid)
  throw new Error(
    "no claim within 5 minutes: check the keeper (railway logs --service keeper), then run with --wait",
  );
const c = paid.args;
const after = {
  vault: await balanceOf(vault),
  bond: await bondOf(),
  pool: await balanceOf(d.pool),
};
console.log(`Claim paid: ${tx(paid.transactionHash)}`);
console.log(`  loss         ${usd(c.lossBase)}`);
console.log(`  payout       ${usd(c.payout)}  (loss minus the 10% deductible, capped at cover)`);
console.log(`  from bond    ${usd(c.fromBond)}`);
console.log(`  from pool    ${usd(c.fromPool)}`);
if (c.premiumNetted > 0n) console.log(`  premium owed ${usd(c.premiumNetted)} (netted)`);
console.log(`After: vault ${usd(after.vault)}, operator bond ${usd(after.bond)}`);

await writeFile(
  OUTPUT,
  `${JSON.stringify(
    {
      network: "Robinhood Chain testnet",
      at: new Date().toISOString(),
      agentId: agentId.toString(),
      vault,
      attack: ATTACK,
      ...take,
      claimTx: paid.transactionHash,
      claim: plain(c),
      after: plain(after),
    },
    null,
    2,
  )}\n`,
);
console.log(`Evidence: ${OUTPUT}`);
