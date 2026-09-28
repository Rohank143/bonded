#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createVulnerableAgent, type Brain } from "@bonded/demo-agents";
import { EVM_CHAINS } from "@bonded/shared";
import { loadAttackLibrary } from "./attacks.js";
import { type EpisodeResult, runEpisode, saveEpisode } from "./episode.js";
import { describeOutcome, summarise } from "./report.js";
import { Sandbox } from "./sandbox.js";

const USAGE = `Usage: pnpm --filter @bonded/arena arena run [options]

Runs Arena episodes against vulnerable-agent and prints each verdict.

Options:
  --attack <id|all|none>   attack seed to plant (default: all; "none" runs a control episode)
  --brain <scripted|llm>   agent brain (default: scripted; llm needs OPENROUTER_API_KEY)
  --model <id>             model for the llm brain, e.g. deepseek/deepseek-v4.1-flash
                           (any OpenRouter model id; LLM_BASE_URL switches endpoint)
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
      model: { type: "string" },
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
  if (values.brain !== "scripted" && values.brain !== "llm") {
    throw new Error(`unknown brain ${values.brain}`);
  }
  const attacks =
    values.attack === "all"
      ? library
      : values.attack === "none"
        ? [null]
        : [library.find((s) => s.id === values.attack) ?? missing(values.attack)];

  // Build the agent first, so a missing API key fails before a sandbox is started.
  const agent = createVulnerableAgent(
    values.brain as Brain,
    values.model ? { model: values.model } : {},
  );
  const forkUrl = values.fork ? (FORKS[values.fork] ?? values.fork) : undefined;
  console.log(forkUrl ? `Forking ${forkUrl}` : "Starting a fresh local chain");
  const sandbox = await Sandbox.start({ forkUrl, log: (m) => m && console.log(m) });
  const results: EpisodeResult[] = [];
  try {
    for (const attack of attacks) {
      const result = await runEpisode(sandbox, { agent, attack });
      results.push(result);
      const path = saveEpisode(result, values.traces);
      console.log(`\n${attack?.id ?? "control (no attack)"}`);
      console.log(`  agent:    ${result.agent} (${result.agentSummary.steps} tool calls)`);
      const usage = result.agentSummary.usage;
      if (usage) {
        const cost = usage.costUsd === undefined ? "" : `, $${usage.costUsd.toFixed(4)}`;
        console.log(
          `  model:    ${usage.inputTokens} input + ${usage.outputTokens} output tokens${cost}`,
        );
      }
      console.log(`  verdict:  ${describeOutcome(result)}`);
      for (const b of result.verdict.breaches) {
        console.log(`  breach:   ${b.type}, loss $${b.lossUsd.toLocaleString("en-US")}`);
      }
      console.log(`  trace:    ${path}`);
    }
  } finally {
    await sandbox.stop();
  }
  console.log(`\n${summarise(results)}`);
  return 0;
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
