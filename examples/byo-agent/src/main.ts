import { readFileSync } from "node:fs";
import { BondedVault, fromBondedEnv, type TokenInfo } from "@bonded/sdk";
import { defineChain, getAddress, type Hex, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { runOnce } from "./agent.js";
import { runEpisode } from "./episode.js";

/**
 * Under the Bonded runner (BONDED_EPISODE_ID is set), runs one Arena episode: see
 * src/episode.ts. Otherwise runs one cycle against your real vault, configured by:
 *
 *   BONDED_RPC_URL     RPC of the chain the vault is on
 *   BONDED_CHAIN_ID    that chain's id
 *   BONDED_VAULT       the Mandate Vault
 *   BONDED_AGENT_KEY   the vault's agent key (0x-prefixed private key); keep it out of the repo
 *   BONDED_ROUTER      the swap router the mandate allows
 *   BONDED_TOKENS      the base asset first, then the others: SYMBOL:0xaddress:decimals,...
 *   BONDED_TARGET      the token to hold (a symbol from BONDED_TOKENS)
 *   BONDED_TRADE_SIZE  base asset to spend per trade, in whole units (default 100)
 *   BONDED_INBOX       optional: a file with one message per line, read as untrusted input
 *   BONDED_API_URL     optional: ask Sentinel at this Bonded API before each trade
 *   BONDED_MANDATE     with BONDED_API_URL: the mandate in plain words
 */
async function main() {
  if (process.env.BONDED_EPISODE_ID) {
    const outcomes = await runEpisode(fromBondedEnv(), {
      ...(process.env.BONDED_TARGET ? { target: process.env.BONDED_TARGET } : {}),
    });
    for (const o of outcomes) console.log(`${o.status}: ${o.action.type} (${o.why}) ${o.detail}`);
    return;
  }
  const env = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`set ${name} (see examples/byo-agent/README.md)`);
    return value;
  };
  const chainId = Number(env("BONDED_CHAIN_ID"));
  const rpcUrl = env("BONDED_RPC_URL");
  const chain = defineChain({
    id: chainId,
    name: `chain ${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const tokens: TokenInfo[] = env("BONDED_TOKENS")
    .split(",")
    .map((entry) => {
      const [symbol, address, decimals] = entry.split(":");
      if (!symbol || !address || !isAddress(address) || !decimals)
        throw new Error(`BONDED_TOKENS: "${entry}" isn't SYMBOL:0xaddress:decimals`);
      return { symbol, address: getAddress(address), decimals: Number(decimals) };
    });
  const vault = new BondedVault({
    vault: getAddress(env("BONDED_VAULT")),
    chain,
    rpcUrl,
    account: privateKeyToAccount(env("BONDED_AGENT_KEY") as Hex),
    router: getAddress(env("BONDED_ROUTER")),
  });
  const inboxFile = process.env.BONDED_INBOX;
  const inbox = inboxFile
    ? readFileSync(inboxFile, "utf8")
        .split("\n")
        .filter((line) => line.trim())
    : [];
  const apiUrl = process.env.BONDED_API_URL;
  const outcomes = await runOnce(
    vault,
    { tokens, target: env("BONDED_TARGET"), tradeSize: process.env.BONDED_TRADE_SIZE ?? "100" },
    inbox,
    apiUrl ? { apiUrl, mandate: env("BONDED_MANDATE"), tokens } : undefined,
  );
  for (const o of outcomes) console.log(`${o.status}: ${o.action.type} (${o.why}) ${o.detail}`);
  const status = await vault.status();
  console.log(
    `vault ${vault.address}: ${status.mode}, ${status.frozen ? "frozen" : "active"}, ${status.breachCount} breaches`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
