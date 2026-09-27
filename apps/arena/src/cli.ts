#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createVulnerableAgent, type VulnerableBrain } from "@bonded/demo-agents";
import { EVM_CHAINS } from "@bonded/shared";
import { loadAttackLibrary } from "./attacks.js";
import { type EpisodeResult, runEpisode, saveEpisode } from "./episode.js";
import { Sandbox } from "./sandbox.js";

const USAGE = `Usage: pnpm --filter @bonded/arena arena run [options]

Runs Arena episodes against vulnerable-agent and prints each verdict.

Options:
  --attack <id|all|none>   attack seed to plant (default: all; "none" runs a control episode)
  --brain <scripted|claude> agent brain (default: scripted; claude needs ANTHROPIC_API_KEY)
  --fork <robinhood|arbitrum|url>  fork a live testnet instead of a fresh local chain
  --traces <dir>           write each episode's full record here (default: traces)
  --list                   list the attack library and exit`;

const FORKS: Record<string, string> = {
  robinhood: EVM_CHAINS.robinhoodTestnet.rpcUrl,
  arbitrum: EVM_CHAINS.arbitrumSepolia.rpcUrl,
};

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      attack: { type: "string", default: "all" },
      brain: { type: "string", default: "scripted" },
      fork: { type: "string" },
      traces: { type: "string", default: "traces" },
      list: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || (positionals[0] !== "run" && !values.list)) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const library = loadAttackLibrary();
  if (values.list) {
    for (const spec of library) console.log(`${spec.id.padEnd(34)} ${spec.title}`);
    return 0;
  }
  if (values.brain !== "scripted" && values.brain !== "claude") {
    throw new Error(`unknown brain ${values.brain}`);
  }
  const attacks =
    values.attack === "all"
      ? library
      : values.attack === "none"
        ? [null]
        : [library.find((s) => s.id === values.attack) ?? missing(values.attack)];

  const forkUrl = values.fork ? (FORKS[values.fork] ?? values.fork) : undefined;
  console.log(forkUrl ? `Forking ${forkUrl}` : "Starting a fresh local chain");
  const sandbox = await Sandbox.start({ forkUrl, log: (m) => m && console.log(m) });
  const results: EpisodeResult[] = [];
  try {
    const agent = createVulnerableAgent(values.brain as VulnerableBrain);
    for (const attack of attacks) {
      const result = await runEpisode(sandbox, { agent, attack });
      results.push(result);
      const path = saveEpisode(result, values.traces);
      console.log(`\n${attack?.id ?? "control (no attack)"}`);
      console.log(`  agent:    ${result.agent} (${result.agentSummary.steps} tool calls)`);
      console.log(`  verdict:  ${verdictLine(result)}`);
      for (const b of result.verdict.breaches) {
        console.log(`  breach:   ${b.type}, loss $${b.lossUsd.toLocaleString("en-US")}`);
      }
      console.log(`  trace:    ${path}`);
    }
  } finally {
    await sandbox.stop();
  }
  const breached = results.filter((r) => r.verdict.breached).length;
  console.log(`\n${breached} of ${results.length} episodes breached the mandate.`);
  return 0;
}

function verdictLine(result: EpisodeResult): string {
  const v = result.verdict;
  if (!v.breached) return "SAFE: no breach recorded";
  const outcome =
    v.attackSucceeded === null
      ? ""
      : v.attackSucceeded
        ? " (attack succeeded)"
        : " (attack failed)";
  return `BREACHED${outcome}, agent ${v.frozen ? "frozen" : "not frozen"}`;
}

function missing(id: string | undefined): never {
  throw new Error(`no attack with id ${id} (use --list)`);
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
