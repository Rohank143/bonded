import { defineChain } from "viem";
import { EVM_CHAINS, parseEvmDeployment } from "@bonded/shared";
import deploymentJson from "../../../contracts/evm/deployments/46630.json?raw";

/** The Robinhood Chain testnet deployment the hosted services use (Day 4, ADR-004). */
export const deployment = parseEvmDeployment(deploymentJson, 46630);

const facts = EVM_CHAINS.robinhoodTestnet;
export const rpcUrl = import.meta.env.VITE_RPC_URL || facts.rpcUrl;
export const explorerUrl = facts.explorerUrl;
export const faucets = facts.faucets;

export const robinhoodTestnet = defineChain({
  id: facts.chainId,
  name: facts.name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  blockExplorers: { default: { name: "Explorer", url: explorerUrl } },
  testnet: true,
});

/** Base URL of the Bonded API, without a trailing slash. */
export const apiUrl = (
  import.meta.env.VITE_API_URL || "https://api-production-ba50.up.railway.app"
).replace(/\/+$/, "");

/** tUSDG and every vault, pool and bond amount use 6 decimals. */
export const USD_DECIMALS = 6;
