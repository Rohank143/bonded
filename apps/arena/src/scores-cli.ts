#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EVM_CHAINS, type EvmChainKey, SOLANA_DEVNET } from "@bondedhq/shared";
import { Keypair } from "@solana/web3.js";
import {
  AGENT_LINKS_FILE,
  type AgentLink,
  crosspostEvm,
  crosspostSolana,
  readEvmScore,
  readLinks,
  readSolanaScore,
  type ScoreChain,
  writeLinks,
} from "./crosspost.js";
import { loadDotEnv } from "./env.js";

const USAGE = `Usage:
  pnpm scores crosspost --agent <id> [options]   post the home chain's score to the other chains
  pnpm scores read --agent <id> [--evidence <path>]  show the agent's score on every chain

  --agent <id>          the agent's id on its home chain
  --home <chain>        home chain (default: robinhoodTestnet)
  --to <chains>         comma-separated targets (default: arbitrumSepolia,sepolia,solanaDevnet)
  --attester-env <var>  .env variable holding the EVM attester key (default: ATTESTER_KEY)
  --owner-env <var>     .env variable holding the key that owns new EVM registrations
                        (default: the attester's)
  --solana-rpc <url>    Solana RPC (default: devnet)
  --solana-keys <dir>   folder with attester.json and operator.json for Solana
                        (default: ~/.config/bonded/solana-devnet)
  --evidence <path>     also write the results as JSON
  --links <path>        the agent-links file (default: config/agent-links.json); use another for a
                        rehearsal on a local validator

Agent ids per chain are kept in config/agent-links.json and updated when an agent is registered.`;

/** pnpm runs the script from apps/arena; resolve paths against the caller's directory. */
const fromCaller = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path);

const DEFAULT_TARGETS: ScoreChain[] = ["arbitrumSepolia", "sepolia", "solanaDevnet"];

function keypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

function hexKey(name: string): `0x${string}` {
  const value = process.env[name];
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error(`${name} must hold a 0x private key (in .env)`);
  return value as `0x${string}`;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: "string" },
      home: { type: "string", default: "robinhoodTestnet" },
      to: { type: "string" },
      "attester-env": { type: "string", default: "ATTESTER_KEY" },
      "owner-env": { type: "string" },
      "solana-rpc": { type: "string", default: SOLANA_DEVNET.rpcUrl },
      "solana-keys": { type: "string", default: join(homedir(), ".config/bonded/solana-devnet") },
      evidence: { type: "string" },
      links: { type: "string", default: AGENT_LINKS_FILE },
      help: { type: "boolean", default: false },
    },
  });
  const command = positionals[0];
  if (values.help || !values.agent || (command !== "crosspost" && command !== "read")) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const home = values.home as EvmChainKey;
  if (!(home in EVM_CHAINS)) throw new Error(`unknown home chain ${home}`);
  const linksFile = fromCaller(values.links);
  const evidence = values.evidence ? fromCaller(values.evidence) : undefined;
  const links = readLinks(linksFile);
  let link = links.find((l) => l.home.chain === home && l.home.agentId === values.agent);
  if (!link) {
    link = { home: { chain: home, agentId: values.agent }, links: {} };
    links.push(link);
  }
  const targets = (values.to?.split(",") ?? DEFAULT_TARGETS) as ScoreChain[];
  for (const t of targets)
    if (t !== "solanaDevnet" && !(t in EVM_CHAINS)) throw new Error(`unknown chain ${t}`);

  if (command === "read") return read(link, targets, values["solana-rpc"], evidence);

  loadDotEnv();
  const homeScore = await readEvmScore(home, values.agent);
  if (!homeScore) throw new Error(`agent ${values.agent} has no score on ${home}`);
  console.log(
    `Home: ${home} agent ${values.agent}, score ${homeScore.score}, issued ${new Date(homeScore.issuedAt * 1000).toISOString()}`,
  );
  // EVM keys only when an EVM chain is a target.
  const evmTargets = targets.some((t) => t !== "solanaDevnet");
  const attesterKey = evmTargets ? hexKey(values["attester-env"]) : undefined;
  const ownerKey = values["owner-env"] ? hexKey(values["owner-env"]) : attesterKey;
  const uri = `bonded://${home}/agent/${values.agent}`;
  const results = [];
  for (const chain of targets) {
    const agentId = link.links[chain];
    // Record a new registration as soon as it's confirmed, so a failed score post can't lose it
    // and a retry doesn't register the agent again.
    const onRegistered = (id: string) => {
      link.links[chain] = id;
      writeLinks(links, linksFile);
    };
    const result =
      chain === "solanaDevnet"
        ? await crosspostSolana({
            rpcUrl: values["solana-rpc"],
            home: homeScore,
            ...(agentId ? { agentId } : {}),
            uri,
            attester: keypair(join(values["solana-keys"], "attester.json")),
            owner: keypair(join(values["solana-keys"], "operator.json")),
            onRegistered,
          })
        : await crosspostEvm({
            chain,
            home: homeScore,
            ...(agentId ? { agentId } : {}),
            uri,
            attesterKey: attesterKey!,
            ownerKey: ownerKey!,
            onRegistered,
          });
    link.links[chain] = result.agentId;
    results.push(result);
    console.log(
      `  ${chain.padEnd(16)} agent ${result.agentId.padEnd(4)} ${result.status}${result.registeredNow ? " (registered now)" : ""}${result.tx ? ` ${result.tx}` : ""}`,
    );
  }
  writeLinks(links, linksFile);
  if (evidence)
    writeFileSync(
      evidence,
      `${JSON.stringify({ home: link.home, score: homeScore, results }, null, 2)}\n`,
    );
  return 0;
}

async function read(
  link: AgentLink,
  targets: ScoreChain[],
  solanaRpc: string,
  evidence?: string,
): Promise<number> {
  const rows: [
    string,
    string,
    (
      | Awaited<ReturnType<typeof readEvmScore>>
      | { score: number; issuedAt: number; expiresAt: number }
      | null
    ),
  ][] = [];
  rows.push([
    link.home.chain,
    link.home.agentId,
    await readEvmScore(link.home.chain, link.home.agentId),
  ]);
  for (const chain of targets) {
    const id = link.links[chain];
    if (!id) {
      rows.push([chain, "-", null]);
      continue;
    }
    rows.push([
      chain,
      id,
      chain === "solanaDevnet"
        ? await readSolanaScore(solanaRpc, id)
        : await readEvmScore(chain, id),
    ]);
  }
  let missing = 0;
  for (const [chain, id, s] of rows) {
    if (!s) missing++;
    console.log(
      `${chain.padEnd(18)} agent ${id.padEnd(4)} ${s ? `score ${s.score}, issued ${new Date(s.issuedAt * 1000).toISOString()}, expires ${new Date(s.expiresAt * 1000).toISOString()}` : "no score"}`,
    );
  }
  if (evidence)
    writeFileSync(
      evidence,
      `${JSON.stringify(
        {
          readAt: new Date().toISOString(),
          home: link.home,
          chains: rows.map(([chain, agentId, s]) => ({
            chain,
            agentId,
            score: s?.score ?? null,
            issuedAt: s ? new Date(s.issuedAt * 1000).toISOString() : null,
            expiresAt: s ? new Date(s.expiresAt * 1000).toISOString() : null,
          })),
        },
        null,
        2,
      )}\n`,
    );
  return missing ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
