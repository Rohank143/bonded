// Creates the demo's Agent A on Robinhood testnet (docs/SPECIFICATION.md, Day 14 detail): the partly
// hardened agent whose guard checks addresses by their first and last characters only. It
// registers the agent, creates its Monitor-mode vault (refunds to the depositor allowed, which is
// the address its weak check trusts), stakes the minimum bond for tier BB at the planned cover,
// funds the vault and the agent key's gas, and prints the config entry the API needs.
//
//   pnpm demo:seed-agent -- [--write-config] [--dry-run] [--local]
//
// Signs with DEPLOYER_PRIVATE_KEY from .env (never printed). The agent's own key is
// DEMO_AGENT_KEY in .env; if it is missing, a new one is generated and appended to .env, also
// never printed. `--local` runs the same steps against a throwaway local chain.
import process from "node:process";
import console from "node:console";
import { appendFile, readFile, writeFile } from "node:fs/promises";
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
} from "@bondedhq/shared";
import {
  getAbiItem,
  keccak256,
  parseEther,
  parseEventLogs,
  stringToBytes,
  toFunctionSelector,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const CONFIG = "config/agents.46630.json";
/** Cover the demo buys, and the bond tier BB needs for it (20%). */
const COVER = 20_000;
const BOND = 4_000;
const DEPOSIT = 50_000;
const CODE_HASH = keccak256(stringToBytes("bonded/scripted-partial/v0"));

const args = process.argv.slice(2);
const { values } = parseArgs({
  args: args[0] === "--" ? args.slice(1) : args,
  options: {
    "write-config": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    local: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log("Usage: pnpm demo:seed-agent -- [--write-config] [--dry-run] [--local]");
  process.exit(0);
}

// One Agent A: running this twice would create a second, unused agent.
const existing = values.local ? [] : JSON.parse(await readFile(CONFIG, "utf8"));
if (existing.some((entry) => entry.kind === "partial"))
  throw new Error(`${CONFIG} already has the partial demo agent`);
if (values["dry-run"]) {
  console.log(
    `Dry run: ${CONFIG} has no partial agent yet. It would register Agent A, create its Monitor-mode ` +
      `vault, stake ${BOND} tUSDG of bond, deposit ${DEPOSIT} tUSDG and print the config entry. Nothing was sent.`,
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

  // The agent's execution key: kept in .env so `demo:break` can act as the agent later.
  let agentKey = values.local ? generatePrivateKey() : process.env.DEMO_AGENT_KEY;
  if (!agentKey) {
    agentKey = generatePrivateKey();
    await appendFile(
      ".env",
      `\n# Agent A's execution key (demo, testnet only)\nDEMO_AGENT_KEY=${agentKey}\n`,
    );
    console.log("Generated DEMO_AGENT_KEY and saved it to .env (not printed).");
  }
  const agentAddress = privateKeyToAccount(agentKey).address;
  console.log(`Chain ${d.chainId}; sender ${account}; agent key ${agentAddress}`);

  const send = async (address, abi, name, args) => {
    const hash = await chain.send(address, abi, name, args);
    console.log(`${name}: ${hash}`);
    return chain.read.waitForTransactionReceipt({ hash, confirmations: values.local ? 1 : 2 });
  };
  const usd = (n) => BigInt(n) * 1000000n;

  const registered = await send(d.registry, bondedRegistryAbi, "register", [
    "ipfs://bonded/day-14/agent-a",
  ]);
  const agentId = parseEventLogs({
    abi: bondedRegistryAbi,
    logs: registered.logs,
    eventName: "Registered",
  })[0].args.agentId;
  // The Gate 1 mandate in Monitor mode, plus one allowed destination: refunds to the depositor.
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
    destinations: [account],
    limits: {
      maxTxNotionalUsd: 5000,
      maxDailyNotionalUsd: 25000,
      maxDrawdownBps: 1500,
      maxSlippageBps: 300,
    },
    freezeOnBreach: true,
    description:
      "Demo Agent A: buys tech Stock Tokens; may refund the depositor. Checks addresses by their ends only.",
  });
  const created = await send(d.factory, mandateVaultFactoryAbi, "createVault", [
    toEvmMandateParams(mandate),
    agentAddress,
    account,
    agentId,
    "Agent A Demo Vault",
    "AGTA",
  ]);
  const vault = parseEventLogs({
    abi: mandateVaultFactoryAbi,
    logs: created.logs,
    eventName: "VaultCreated",
  })[0].args.vault;

  await send(d.usdg, testTokenAbi, "faucet", [usd(BOND + DEPOSIT)]);
  await send(d.usdg, testTokenAbi, "approve", [d.bond, usd(BOND)]);
  await send(d.bond, operatorBondAbi, "stake", [agentId, usd(BOND)]);
  await send(d.usdg, testTokenAbi, "approve", [vault, usd(DEPOSIT)]);
  await send(vault, mandateVaultAbi, "deposit", [usd(DEPOSIT), account]);
  // Gas for the agent's own transactions in `demo:break`.
  const gas = await chain.wallet.sendTransaction({ to: agentAddress, value: parseEther("0.002") });
  await chain.read.waitForTransactionReceipt({ hash: gas });
  console.log(`agent gas: ${gas}`);

  const entry = { kind: "partial", mandate, codeHash: CODE_HASH, repeats: 5 };
  if (values["write-config"] && !values.local) {
    await writeFile(CONFIG, `${JSON.stringify([...existing, entry], null, 2)}\n`);
    console.log(`Added agent ${agentId} to ${CONFIG}. Format and commit it.`);
  }
  console.log(
    `\nAgent A: agent ${agentId}, vault ${vault}, agent key ${agentAddress}, cover planned ${COVER}.`,
  );
  // The last line is machine-readable.
  console.log(
    JSON.stringify({ agentId: agentId.toString(), vault, agentKey: agentAddress, entry }),
  );
} finally {
  await sandbox?.stop();
}
