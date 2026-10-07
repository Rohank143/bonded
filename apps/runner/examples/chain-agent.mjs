#!/usr/bin/env node
/**
 * A minimal agent for the Bonded runner in chain mode: reads are tool calls over plain HTTP, and
 * trades are transactions it signs itself and sends to its vault, as it would in production.
 *
 *   bonded-runner --gateway <url> --mode chain -- node chain-agent.mjs
 *
 * Each episode gives it a fresh session key (BONDED_SESSION_KEY) that the episode's vault accepts
 * as its agent, an RPC endpoint for the episode's chain (BONDED_RPC_URL), its vault, and the
 * exchange and token addresses (BONDED_CONTRACTS). Every trade is MandateVault.execute(target,
 * data): the vault checks it against the mandate on chain.
 *
 * Needs viem (npm install viem).
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  maxUint256,
  parseAbi,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const env = process.env;
const task = JSON.parse(env.BONDED_TASK);
const contracts = JSON.parse(env.BONDED_CONTRACTS);
const vault = env.BONDED_VAULT;
const chain = defineChain({
  id: Number(env.BONDED_CHAIN_ID),
  name: "episode",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.BONDED_RPC_URL] } },
});
const account = privateKeyToAccount(env.BONDED_SESSION_KEY);
const reader = createPublicClient({ chain, transport: http(), pollingInterval: 100 });
const wallet = createWalletClient({ account, chain, transport: http() });

const vaultAbi = parseAbi([
  "function execute(address target, bytes data) returns (bytes)",
  "function breachCount() view returns (uint256)",
]);
const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
const routerAbi = parseAbi([
  "function swap(address tokenIn, address tokenOut, uint256 amountIn, address recipient) returns (uint256)",
]);

/** Reads over plain HTTP: POST {tools}/{name} with the arguments as JSON. */
async function read(name, args = {}) {
  const response = await fetch(`${env.BONDED_TOOLS_URL}/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return response.json();
}

/** Sends one action through the vault, signed by this episode's key. */
async function execute(target, data) {
  const { request } = await reader.simulateContract({
    address: vault,
    abi: vaultAbi,
    functionName: "execute",
    args: [target, data],
    account,
  });
  const hash = await wallet.writeContract(request);
  return reader.waitForTransactionReceipt({ hash });
}

const token = (symbol) =>
  contracts.tokens.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase());

for (const name of ["read_inbox", "read_news", "get_market_report"]) await read(name);

let finalMessage = "No trade in the task I could parse.";
const goal =
  /\bbuy\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s+(t[A-Z]{3,5})\s+worth\s+of\s+(t[A-Z]{3,5})\b/i.exec(
    task.goal,
  );
if (goal) {
  const tokenIn = token(goal[2]);
  const tokenOut = token(goal[3]);
  const amountIn = parseUnits(goal[1].replaceAll(",", ""), tokenIn.decimals);
  const allowance = await reader.readContract({
    address: tokenIn.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: [vault, contracts.exchange],
  });
  if (allowance < amountIn) {
    await execute(
      tokenIn.address,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [contracts.exchange, maxUint256],
      }),
    );
  }
  const receipt = await execute(
    contracts.exchange,
    encodeFunctionData({
      abi: routerAbi,
      functionName: "swap",
      args: [tokenIn.address, tokenOut.address, amountIn, vault],
    }),
  );
  finalMessage = `Swapped ${goal[1]} ${tokenIn.symbol} for ${tokenOut.symbol} in ${receipt.transactionHash}`;
}

await fetch(env.BONDED_DONE_URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ finalMessage }),
});
console.log(finalMessage);
