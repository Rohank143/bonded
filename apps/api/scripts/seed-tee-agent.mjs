// Creates the TEE demo agent on Robinhood testnet: registers an agent, creates its vault with the
// TEE's EVM key as the vault's execution key, funds the operator bond and the vault, and prints
// the config entry the API needs (docs/TEE.md, step 7). It is not agent 2: that is the Gate 1
// vault, and changing its key would break its scripted live flow.
//
//   pnpm tee:seed -- --tee-address 0x… --tee-url https://… --compose-hash 0x… --code-hash 0x… [--write-config] [--dry-run]
//
// It signs with DEPLOYER_PRIVATE_KEY from .env (never printed) and sends testnet transactions.
// `--local` runs the same steps against a throwaway local chain, for testing the script itself.
import process from "node:process";
import console from "node:console";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Sandbox, ANVIL_KEYS, loadDotEnv } from "@bonded/arena";
import { connectChain } from "@bonded/keeper";
import {
  EvmMandate,
  parseEvmDeployment,
  toEvmMandateParams,
  bondedRegistryAbi,
  mandateVaultFactoryAbi,
  mandateVaultAbi,
  testTokenAbi,
  operatorBondAbi,
  demoRouterAbi,
} from "@bonded/shared";
import { getAbiItem, toFunctionSelector, parseEventLogs } from "viem";

const CONFIG = "config/agents.46630.json";
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const { values } = parseArgs({
  options: {
    "tee-address": { type: "string" },
    "tee-url": { type: "string" },
    "compose-hash": { type: "string" },
    "code-hash": { type: "string" },
    "write-config": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    local: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
const usage =
  "Usage: pnpm tee:seed -- --tee-address 0x<TEE EVM address> --tee-url https://<app url> " +
  "--compose-hash 0x<64 hex> --code-hash 0x<64 hex> [--write-config] [--dry-run]\n" +
  "  --tee-address   the TEE agent's EVM key: `curl <tee-url>/health` (VM running), or the evidence\n" +
  "                  from your last rating. It becomes the vault's execution key.\n" +
  "  --write-config  add the agent to config/agents.46630.json (then commit it)\n" +
  "  --dry-run       check the arguments and the config, send nothing";
if (values.help) {
  console.log(usage);
  process.exit(0);
}
const fail = (message) => {
  console.error(`${message}\n\n${usage}`);
  process.exit(2);
};
const teeAddress = values["tee-address"];
const teeUrl = values["tee-url"];
const composeHash = values["compose-hash"];
const codeHash = values["code-hash"];
if (!teeAddress || !ADDRESS.test(teeAddress)) fail("--tee-address must be an EVM address");
if (!teeUrl || !/^https:\/\/\S+$/.test(teeUrl)) fail("--tee-url must be an https URL");
if (!composeHash || !HEX32.test(composeHash)) fail("--compose-hash must be 0x and 64 hex digits");
if (!codeHash || !HEX32.test(codeHash)) fail("--code-hash must be 0x and 64 hex digits");

// One TEE URL, one demo agent: running this twice would create a second, unused agent.
const existing = values.local ? [] : JSON.parse(await readFile(CONFIG, "utf8"));
if (existing.some((entry) => entry.tee?.url === teeUrl))
  fail(`${CONFIG} already has an agent for ${teeUrl}.`);

if (values["dry-run"]) {
  console.log(
    `Dry run: the arguments and ${CONFIG} are fine. It would register an agent, create a vault whose ` +
      `execution key is ${teeAddress}, fund the bond and the vault, and print the config entry. Nothing was sent.`,
  );
  process.exit(0);
}

let sandbox;
try {
  if (values.local) sandbox = await Sandbox.start();
  else loadDotEnv();
  const d = values.local
    ? sandbox.deployment
    : parseEvmDeployment(await readFile("contracts/evm/deployments/46630.json", "utf8"), 46630);
  const rpc = values.local ? sandbox.rpcUrl : "https://rpc.testnet.chain.robinhood.com/rpc";
  const raw = values.local ? ANVIL_KEYS.deployer : process.env.DEPLOYER_PRIVATE_KEY;
  if (!raw) throw new Error("DEPLOYER_PRIVATE_KEY is required (in .env)");
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  const chain = connectChain(d, rpc, key);
  if ((await chain.read.getChainId()) !== d.chainId) throw new Error("RPC chain mismatch");
  if (!values.local && d.chainId !== 46630) throw new Error("testnet only");
  const account = chain.wallet.account.address;
  console.log(`Chain ${d.chainId}; sender ${account}; vault execution key ${teeAddress}`);

  const send = async (address, abi, name, args) => {
    const hash = await chain.send(address, abi, name, args);
    console.log(`${name}: ${hash}`);
    return chain.read.waitForTransactionReceipt({ hash, confirmations: values.local ? 1 : 2 });
  };
  const usd = (n) => BigInt(n) * 1000000n;

  const registered = await send(d.registry, bondedRegistryAbi, "register", [
    "ipfs://bonded/day-11/tee-hardened",
  ]);
  const agentId = parseEventLogs({
    abi: bondedRegistryAbi,
    logs: registered.logs,
    eventName: "Registered",
  })[0].args.agentId;
  // Same mandate as the Gate 1 agent, but in Enforce mode like the plan's hardened demo agent.
  const mandate = EvmMandate.parse({
    version: 1,
    chain: { family: "evm", chainId: d.chainId },
    agentId: agentId.toString(),
    mode: "enforce",
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
    description: "TEE demo agent: the hardened agent, its vault run by the TEE's key.",
  });
  // The agent's key is the TEE's key. The guardian stays with the sender, who can rotate it.
  const created = await send(d.factory, mandateVaultFactoryAbi, "createVault", [
    toEvmMandateParams(mandate),
    teeAddress,
    account,
    agentId,
    "TEE Demo Vault",
    "TEEV",
  ]);
  const vault = parseEventLogs({
    abi: mandateVaultFactoryAbi,
    logs: created.logs,
    eventName: "VaultCreated",
  })[0].args.vault;
  const bound = await chain.read.readContract({
    address: vault,
    abi: mandateVaultAbi,
    functionName: "agent",
  });
  if (bound.toLowerCase() !== teeAddress.toLowerCase())
    throw new Error("the vault's execution key is not the TEE's key");

  await send(d.usdg, testTokenAbi, "faucet", [usd(60000)]);
  await send(d.usdg, testTokenAbi, "approve", [d.bond, usd(10000)]);
  await send(d.bond, operatorBondAbi, "stake", [agentId, usd(10000)]);
  await send(d.usdg, testTokenAbi, "approve", [vault, usd(50000)]);
  await send(vault, mandateVaultAbi, "deposit", [usd(50000), account]);

  const entry = { kind: "hardened", mandate, codeHash, tee: { url: teeUrl, composeHash } };
  if (values["write-config"] && !values.local) {
    await writeFile(CONFIG, `${JSON.stringify([...existing, entry], null, 2)}\n`);
    console.log(`Added agent ${agentId} to ${CONFIG}. Format and commit it.`);
  }
  console.log(`\nAgent ${agentId}, vault ${vault}, execution key ${bound}.`);
  // The last line is machine-readable.
  console.log(JSON.stringify({ agentId: agentId.toString(), vault, executionKey: bound, entry }));
} finally {
  await sandbox?.stop();
}
