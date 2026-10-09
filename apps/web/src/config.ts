import { defineChain } from "viem";
import { EVM_CHAINS, parseEvmDeployment } from "@bondedhq/shared";
import deploymentJson from "../../../contracts/evm/deployments/46630.json?raw";

/**
 * `pnpm demo` serves the app against its own local chain: it passes that deployment in
 * VITE_DEPLOYMENT_JSON (with VITE_RPC_URL and VITE_API_URL). Otherwise it is the Robinhood Chain
 * testnet deployment the hosted services use (Day 4, ADR-004).
 */
const localDeployment = import.meta.env.VITE_DEPLOYMENT_JSON as string | undefined;
export const isLocal = Boolean(localDeployment);
export const deployment = localDeployment
  ? parseEvmDeployment(localDeployment)
  : parseEvmDeployment(deploymentJson, 46630);

const facts = EVM_CHAINS.robinhoodTestnet;
export const networkName = isLocal ? "the local demo chain" : "Robinhood Chain testnet";
export const rpcUrl = import.meta.env.VITE_RPC_URL || facts.rpcUrl;
/** Empty on the local chain, which has no explorer: links then show as plain text. */
export const explorerUrl = isLocal ? "" : facts.explorerUrl;
export const faucets = facts.faucets;

export const robinhoodTestnet = defineChain({
  id: deployment.chainId,
  name: isLocal ? "Bonded local demo" : facts.name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  ...(explorerUrl ? { blockExplorers: { default: { name: "Explorer", url: explorerUrl } } } : {}),
  testnet: true,
});

/** Base URL of the Bonded API, without a trailing slash. */
export const apiUrl = (
  import.meta.env.VITE_API_URL || "https://api-production-ba50.up.railway.app"
).replace(/\/+$/, "");

/** tUSDG and every vault, pool and bond amount use 6 decimals. */
export const USD_DECIMALS = 6;
