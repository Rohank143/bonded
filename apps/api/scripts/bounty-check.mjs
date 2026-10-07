// Checks the hunter's guide on the hosted app (docs/BOUNTIES.md, "Hunter's guide"): a brand-new
// wallet commits an attack on BountyBoard, reveals it, sends it to the hosted API, and waits for
// the Arena's decision and the attester's transaction. The same steps as the Bounties page.
//
//   pnpm check:bounty
//
// Sends real Robinhood testnet transactions. The deployer (DEPLOYER_PRIVATE_KEY in .env, never
// printed) only sends the new wallet a little test ETH for gas. The attack is
// apps/api/scripts/fixtures/bounty-check.yaml: it breaches the undefended agent but not the
// defended one, through a class and surface the library already covers, so the expected outcome
// is a rejection that pays nothing. Evidence goes to artifacts/bounty-testnet.json.
import process from "node:process";
import console from "node:console";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { loadDotEnv, specUri } from "@bonded/arena";
import { connectChain } from "@bonded/keeper";
import { EVM_CHAINS, bountyBoardAbi, parseBountySpec, parseEvmDeployment } from "@bonded/shared";
import { bytesToHex, parseEther, parseEventLogs } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { quoteApiUrl } from "../dist/demo-checks.js";

const { fetch, crypto } = globalThis;
loadDotEnv();
// After loading .env, so an endpoint set only there is used.
const API = quoteApiUrl(process.env);
const RPC = EVM_CHAINS.robinhoodTestnet.rpcUrl;
const EXPLORER = EVM_CHAINS.robinhoodTestnet.explorerUrl;
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
const hunter = connectChain(d, RPC, generatePrivateKey());
const me = hunter.wallet.account.address;
const read = hunter.read;
evidence.wallet = me;
console.log(`New wallet ${me}`);

try {
  const yaml = await readFile("apps/api/scripts/fixtures/bounty-check.yaml", "utf8");
  parseBountySpec(yaml); // the page's check before committing
  const uri = specUri(yaml);
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  evidence.specUri = uri;

  const gas = await deployer.wallet.sendTransaction({ to: me, value: parseEther("0.001") });
  await read.waitForTransactionReceipt({ hash: gas });
  step("Gas sent to the new wallet", { tx: gas });
  const send = async (name, args) => {
    const hash = await hunter.send(d.bountyBoard, bountyBoardAbi, name, args);
    return { hash, receipt: await read.waitForTransactionReceipt({ hash }) };
  };

  const commitment = await read.readContract({
    address: d.bountyBoard,
    abi: bountyBoardAbi,
    functionName: "commitmentFor",
    args: [me, uri, salt],
  });
  const committed = await send("commit", [commitment]);
  const id = parseEventLogs({
    abi: bountyBoardAbi,
    logs: committed.receipt.logs,
    eventName: "Committed",
  })[0].args.id;
  evidence.submissionId = id.toString();
  step(`Committed submission ${id}`, { tx: committed.hash });
  step("Revealed on chain", { tx: (await send("reveal", [id, uri, salt])).hash });

  const res = await fetch(`${API}/bounties/${id}/reveal`, { method: "POST", body: yaml });
  const sent = await res.json();
  if (!res.ok) throw new Error(`send for validation: ${res.status} ${sent.error ?? ""}`);
  step(`Sent for validation (${res.status})`);

  let record;
  for (let i = 0; i < 90; i++) {
    // Ask for the page that starts at this submission.
    const { items: list } = await (await fetch(`${API}/bounties?before=${id + 1n}&limit=1`)).json();
    record = list.find((b) => String(b.submissionId) === id.toString());
    if (record && record.status !== "validating" && record.txHash) break;
    if (i % 6 === 0) console.log(`  ${record?.status ?? "waiting"}…`);
    await delay(10_000);
  }
  if (!record || record.status === "validating") throw new Error("no decision within 15 minutes");
  const onChain = await read.readContract({
    address: d.bountyBoard,
    abi: bountyBoardAbi,
    functionName: "getSubmission",
    args: [id],
  });
  evidence.decision = {
    status: record.status,
    reason: record.reason,
    reward: record.reward,
    onChainStatus: onChain.status,
  };
  step(`Decision: ${record.status}${record.reason ? ` (${record.reason})` : ""}`, {
    tx: record.txHash,
  });
  evidence.ok = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  console.error(`\nStopped: ${evidence.error}`);
  process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/bounty-testnet.json", `${JSON.stringify(evidence, null, 2)}\n`);
  console.log("Evidence: artifacts/bounty-testnet.json");
}
