#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  type Brain,
  createHardenedAgent,
  createVulnerableAgent,
  CascadeSentinel,
  DecisionModelAgent,
  GuardedAgent,
  DecisionModelSentinel,
  LayaSentinel,
  LlmDecisionModel,
  SentinelGuard,
} from "@bonded/demo-agents";
import { type ArenaAgent, EVM_CHAINS, parseSentinelQuestionSet } from "@bonded/shared";
import { loadAttackLibrary } from "./attacks.js";
import { runControls } from "./controls.js";
import { loadDotEnv, usesLanguageModel } from "./env.js";
import { type EpisodeResult, runEpisode, saveEpisode } from "./episode.js";
import { rateAgent } from "./rate.js";
import { attestTeeAgent } from "./tee.js";
import { describeOutcome, summarise } from "./report.js";
import { Sandbox } from "./sandbox.js";

const USAGE = `Usage:
  pnpm --filter @bonded/arena arena run [options]    run episodes and print each verdict
  pnpm --filter @bonded/arena arena rate [options]   full rating: score, report, attestation
  pnpm --filter @bonded/arena arena controls [options]  benign episodes only, for Sentinel's
                                                       false-alarm test (no score)

Agent:
  --agent <vulnerable|hardened|decision>  demo agent to test (default: vulnerable)
  --brain <scripted|llm>   scripted needs nothing; llm needs OPENROUTER_API_KEY (default: scripted)
  --model <id>             model for an llm brain or the decision agent, any OpenRouter model id
                           (LLM_BASE_URL switches to another OpenAI-compatible endpoint)
  --sentinel-model <id>    vulnerable or hardened: add a Sentinel guard that asks this model about each
                           write (vulnerable gets Sentinel alone, hardened gets it after its policy guard);
                           laya:<url> uses a Laya server (LAYA_API_KEY if it needs one)
  --sentinel-fallback <id> with laya:<url>, ask this LLM when Laya is unsure (the cascade)
  --sentinel-questions <s> with laya:<url>, the checkpoint's question set: v1 or v3 (default: v1)
  --enforce                run the vault in Enforce mode (blocked, not just recorded)
  --code-hash <0x..>       rate only: hash of the code version being rated (default: hash of its name)
  --tee-url <https://..>   rate only: the agent's live TEE endpoint. The Arena challenges it, verifies
                           its Intel TDX quote and puts the measurement in the attestation. Needs
                           --code-hash and --tee-compose-hash; the rating fails if verification does not
                           succeed
  --tee-compose-hash <h>   rate only: the compose hash published for that deployment (docs/TEE.md)

Attacks:
  --attack <id|all|none>   run only: seed to plant (default: all; none = control episode)
  --repeats <n>            rate only: runs of each seed, each with a different goal (default: 1)
  --controls <n>           rate: episodes with no attack (default: 2); controls: how many (default: 24)
  --list                   list the attack library and exit

Run:
  --max-usd <n>            rate and controls: stop starting episodes once model spend reaches this
  --fork <robinhood|arbitrum|url>  fork a live testnet instead of a fresh local chain
  --traces <dir>           run only: where to write episode records (default: traces)
  --out <dir>              rate and controls: output directory (default: ratings/<agent>, or
                           ratings/controls-<agent> for controls)`;

const FORKS: Record<string, string> = {
  robinhood: EVM_CHAINS.robinhoodTestnet.rpcUrl,
  arbitrum: EVM_CHAINS.arbitrumSepolia.rpcUrl,
};

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: "string", default: "vulnerable" },
      attack: { type: "string", default: "all" },
      brain: { type: "string", default: "scripted" },
      model: { type: "string" },
      "sentinel-model": { type: "string" },
      "sentinel-fallback": { type: "string" },
      "sentinel-questions": { type: "string" },
      enforce: { type: "boolean", default: false },
      "code-hash": { type: "string" },
      "tee-url": { type: "string" },
      "tee-compose-hash": { type: "string" },
      repeats: { type: "string", default: "1" },
      controls: { type: "string" },
      "max-usd": { type: "string" },
      fork: { type: "string" },
      traces: { type: "string", default: "traces" },
      out: { type: "string" },
      list: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const command = positionals[0];
  if (
    values.help ||
    (command !== "run" && command !== "rate" && command !== "controls" && !values.list)
  ) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const library = loadAttackLibrary();
  if (values.list) {
    for (const spec of library) console.log(`${spec.id.padEnd(34)} ${spec.title}`);
    return 0;
  }

  // Only runs that call a language model read .env (for its API key); local scripted runs
  // never do, as the README promises.
  if (usesLanguageModel(values)) loadDotEnv();
  // Build the agent first, so a missing API key fails before a sandbox is started.
  const agent = buildAgent(values);
  const vault = values.enforce ? { mandate: { mode: "enforce" as const } } : undefined;
  const forkUrl = values.fork ? (FORKS[values.fork] ?? values.fork) : undefined;
  console.log(forkUrl ? `Forking ${forkUrl}` : "Starting a fresh local chain");
  const sandbox = await Sandbox.start({ forkUrl, log: (m) => m && console.log(m) });
  try {
    if (command === "controls") {
      const outDir = values.out ?? `ratings/controls-${agent.name.replaceAll("/", "_")}`;
      const result = await runControls(sandbox, {
        agent,
        episodes: positiveInt(values.controls ?? "24", "--controls"),
        ...(vault ? { vault } : {}),
        ...(values["max-usd"] ? { maxUsd: Number(values["max-usd"]) } : {}),
        outDir,
        onEpisode: (r, i, total) =>
          console.log(`[${i + 1}/${total}] control ${describeOutcome(r)}`),
      });
      console.log(
        `\n${result.episodes.length} control episodes, ${result.rows.length} Sentinel rows, ${result.breaches} breaches`,
      );
      console.log(`  spend $${result.spend.spentUsd.toFixed(4)}`);
      if (result.stoppedEarly) console.log(`  stopped early: ${result.stoppedEarly}`);
      for (const [name, path] of Object.entries(result.files))
        console.log(`  ${name.padEnd(12)}${path}`);
      return 0;
    }
    if (command === "rate") {
      const outDir = values.out ?? `ratings/${agent.name.replaceAll("/", "_")}`;
      const codeHash = hex32(values["code-hash"], "--code-hash");
      const tee = values["tee-url"]
        ? await attestTeeAgent({
            url: values["tee-url"],
            codeHash: codeHash ?? required("--code-hash with --tee-url"),
            composeHash:
              hex32(values["tee-compose-hash"], "--tee-compose-hash") ??
              required("--tee-compose-hash with --tee-url"),
          })
        : undefined;
      if (tee) console.log(`TEE verified: measurement ${tee.measurement}`);
      const result = await rateAgent(sandbox, {
        agent,
        ...(codeHash ? { codeHash } : {}),
        ...(tee ? { tee } : {}),
        attacks: library,
        repeats: positiveInt(values.repeats, "--repeats"),
        controls: positiveInt(values.controls ?? "2", "--controls", true),
        ...(vault ? { vault } : {}),
        ...(values["max-usd"] ? { maxUsd: Number(values["max-usd"]) } : {}),
        outDir,
        onEpisode: (r, i, total) =>
          console.log(
            `[${i + 1}/${total}] ${(r.attackId ?? "control").padEnd(34)} ${describeOutcome(r)}`,
          ),
      });
      const s = result.report.scoring;
      console.log(`\n${agent.name}: Bonded Score ${s.score} (${s.tier})`);
      console.log(`  expected loss ${(s.expectedLoss * 100).toFixed(2)}% of cover a year`);
      console.log(
        `  premium ${(s.premiumRate * 100).toFixed(2)}% a year${s.insurable ? "" : " (not insurable)"}`,
      );
      console.log(
        `  attestation ${result.posted.posted ? "posted to the sandbox registry" : `signed, not posted: ${result.posted.reason}`}`,
      );
      if (result.report.stoppedEarly) console.log(`  stopped early: ${result.report.stoppedEarly}`);
      for (const [name, path] of Object.entries(result.files))
        console.log(`  ${name.padEnd(12)}${path}`);
      return 0;
    }

    const attacks =
      values.attack === "all"
        ? library
        : values.attack === "none"
          ? [null]
          : [library.find((s) => s.id === values.attack) ?? missing(values.attack)];
    const results: EpisodeResult[] = [];
    for (const attack of attacks) {
      const result = await runEpisode(sandbox, { agent, attack, ...(vault ? { vault } : {}) });
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
    console.log(`\n${summarise(results)}`);
    return 0;
  } finally {
    await sandbox.stop();
  }
}

function buildAgent(values: {
  agent?: string;
  brain?: string;
  model?: string;
  "sentinel-model"?: string;
  "sentinel-fallback"?: string;
  "sentinel-questions"?: string;
}): ArenaAgent {
  const brain = values.brain;
  if (brain !== "scripted" && brain !== "llm") throw new Error(`unknown brain ${brain}`);
  const llm = values.model ? { model: values.model } : {};
  const sentinel = values["sentinel-model"]
    ? [
        new SentinelGuard(
          sentinelModel(
            values["sentinel-model"],
            values["sentinel-fallback"],
            values["sentinel-questions"],
          ),
        ),
      ]
    : [];
  switch (values.agent) {
    case "vulnerable": {
      const agent = createVulnerableAgent(brain as Brain, llm);
      // Sentinel alone in front of an agent that does get manipulated: what Sentinel adds.
      return sentinel.length ? new GuardedAgent(agent, sentinel, "sentinel") : agent;
    }
    case "hardened":
      return createHardenedAgent(brain as Brain, llm, sentinel);
    case "decision":
      if (sentinel.length) throw new Error("--sentinel-model works with vulnerable or hardened");
      return new DecisionModelAgent(new LlmDecisionModel(llm));
    default:
      throw new Error(`unknown agent ${values.agent} (vulnerable, hardened or decision)`);
  }
}

/** `laya:<url>` for a Laya server, optionally with an LLM fallback; otherwise an LLM model id. */
function sentinelModel(spec: string, fallback?: string, questions?: string) {
  if (!spec.startsWith("laya:")) {
    if (fallback) throw new Error("--sentinel-fallback needs --sentinel-model laya:<url>");
    if (questions) throw new Error("--sentinel-questions needs --sentinel-model laya:<url>");
    return new LlmDecisionModel({ model: spec });
  }
  const laya = new LayaSentinel({
    url: spec.slice("laya:".length).replace(/\/+$/, ""),
    apiKey: process.env.LAYA_API_KEY,
    questions: parseSentinelQuestionSet(questions),
  });
  return fallback
    ? new CascadeSentinel(
        laya,
        new DecisionModelSentinel(new LlmDecisionModel({ model: fallback })),
      )
    : laya;
}

function positiveInt(text: string | undefined, flag: string, allowZero = false): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1))
    throw new Error(`${flag} must be a whole number`);
  return n;
}

function hex32(text: string | undefined, flag: string): `0x${string}` | undefined {
  if (text === undefined) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(text))
    throw new Error(`${flag} must be 0x followed by 64 hex digits`);
  return text as `0x${string}`;
}

function required(what: string): never {
  throw new Error(`${what} is required`);
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
