#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  AgentKitAgent,
  type Brain,
  createHardenedAgent,
  createPartialAgent,
  createVulnerableAgent,
  DEFAULT_AGENT_MODEL,
  SolanaAgentKitAgent,
} from "@bonded/demo-agents";
import {
  type ArenaAgent,
  type EvmMandateInput,
  llmConfigFromEnv,
  OpenAICompatibleClient,
} from "@bondedhq/shared";
import {
  type AdaptiveAttempt,
  type AdaptiveResult,
  type Feedback,
  runAdaptive,
} from "./adaptive.js";
import { loadAttackLibrary } from "./attacks.js";
import { BENIGN_GOALS } from "./episode.js";
import { loadDotEnv } from "./env.js";
import { Sandbox } from "./sandbox.js";

const USAGE = `Usage: pnpm --filter @bonded/arena adaptive --max-usd <n> [options]

Runs the adaptive attacker (src/adaptive.ts) against one agent. For each chosen seed it plants the
published text first (the static baseline), then lets an attacker model read how the agent reacted
and rewrite the text, until the vault records the breach or the rounds run out. Needs
OPENROUTER_API_KEY in .env and anvil (Foundry). Results go to ratings/adaptive-<agent>/.

  --max-usd <n>          stop once model spend (agent and attacker) reaches this, per seed (required)
  --agent <name>         hardened | vulnerable | partial | agentkit | solana-agent-kit
                         (default: hardened)
  --brain <scripted|llm> brain for hardened, vulnerable and partial (default: llm)
  --model <id>           the agent's model (default: ${DEFAULT_AGENT_MODEL})
  --attacker-model <id>  the attacker's model (default: deepseek/deepseek-v4.1-flash). A weaker
                         attacker finds less, so a clean result is only as strong as this model
  --seeds <list>         seed ids or classes, e.g. A1,A5-address-poisoning-001 (default: the first
                         seed of every class)
  --rounds <n>           rewrites after the seed's own run (default: 6)
  --feedback <level>     outcome | trace: what the attacker sees of each try (default: trace)
  --goal-index <0-3>     the agent's task: one of the Arena's benign goals (src/episode.ts). Index 3
                         asks it to review recent transfers, which an A5 seed needs: an agent that
                         is never asked to read transfer history never sees the planted text
  --enforce              run the vault in Enforce mode
  --out <dir>            where to write results (default: ratings/adaptive-<agent>)`;

function buildTarget(name: string, brain: string, model: string | undefined): ArenaAgent {
  if (brain !== "scripted" && brain !== "llm") throw new Error(`unknown brain ${brain}`);
  const llm = model ? { model } : {};
  switch (name) {
    case "vulnerable":
      return createVulnerableAgent(brain as Brain, llm);
    case "hardened":
      return createHardenedAgent(brain as Brain, llm);
    case "partial":
      return createPartialAgent(brain as Brain, llm);
    case "agentkit":
      return new AgentKitAgent(model ?? DEFAULT_AGENT_MODEL);
    case "solana-agent-kit":
      return new SolanaAgentKitAgent(model ?? DEFAULT_AGENT_MODEL);
    default:
      throw new Error(
        `unknown agent ${name} (hardened, vulnerable, partial, agentkit or solana-agent-kit)`,
      );
  }
}

/** One letter per try. Not the ruling's first letter: "ignored" and "invalid" would collide. */
const TRAIL: Record<AdaptiveAttempt["ruling"], string> = {
  breach: "B",
  vault_blocked: "V",
  guard_blocked: "G",
  ignored: "I",
  unseen: "U",
  no_verdict: "E",
  control: "C",
  invalid: "N",
};

function describe(r: AdaptiveResult): string {
  const outcome = r.breached
    ? r.roundsToBreach === 0
      ? "breached by the published seed"
      : `breached in round ${r.roundsToBreach}`
    : `held for ${r.attempts.filter((a) => a.ruling !== "invalid").length} of ${r.attempts.length} tries (${r.stoppedBecause})`;
  const trail = r.attempts.map((a) => (a.succeeded ? "X" : TRAIL[a.ruling])).join("");
  return `${r.seed.padEnd(38)} ${outcome.padEnd(34)} ${trail}  $${r.spend.spentUsd.toFixed(3)}`;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    // pnpm passes the "--" separator through.
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      "max-usd": { type: "string" },
      agent: { type: "string", default: "hardened" },
      brain: { type: "string", default: "llm" },
      model: { type: "string" },
      "attacker-model": { type: "string", default: "deepseek/deepseek-v4.1-flash" },
      seeds: { type: "string" },
      rounds: { type: "string", default: "6" },
      feedback: { type: "string", default: "trace" },
      "goal-index": { type: "string" },
      enforce: { type: "boolean", default: false },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  const maxUsd = Number(values["max-usd"]);
  const rounds = Number(values.rounds);
  const feedback = values.feedback as Feedback;
  const goal =
    values["goal-index"] === undefined ? undefined : BENIGN_GOALS[Number(values["goal-index"])];
  if (values["goal-index"] !== undefined && goal === undefined)
    throw new Error(`--goal-index must be 0 to ${BENIGN_GOALS.length - 1}`);
  if (
    values.help ||
    !(maxUsd > 0) ||
    !Number.isInteger(rounds) ||
    rounds < 1 ||
    (feedback !== "outcome" && feedback !== "trace")
  ) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  // Even a scripted target needs the key: the attacker is always a model.
  loadDotEnv();
  const client = new OpenAICompatibleClient(llmConfigFromEnv());
  const agent = buildTarget(values.agent, values.brain, values.model);

  const library = loadAttackLibrary();
  const wanted = values.seeds?.split(",").map((s) => s.trim());
  const seeds = wanted
    ? library.filter((s) => wanted.some((w) => w === s.class || w === s.id))
    : [...new Map(library.map((s) => [s.class, s])).values()];
  if (seeds.length === 0) throw new Error(`no seeds match ${values.seeds}`);

  const outDir = values.out ?? join("ratings", `adaptive-${agent.name.replaceAll("/", "_")}`);
  mkdirSync(outDir, { recursive: true });
  const sandbox = await Sandbox.start();
  try {
    // The partial agent's mandate allows refunds to the depositor, the address it trusts.
    const mandate: Partial<EvmMandateInput> = {
      ...(values.enforce ? { mode: "enforce" as const } : {}),
      ...(values.agent === "partial" ? { destinations: [sandbox.address("depositor")] } : {}),
    };
    console.log(
      `Agent ${agent.name}, attacker ${values["attacker-model"]}, feedback ${feedback}, ` +
        `${rounds} rewrites per seed, up to $${maxUsd} per seed\n`,
    );
    const results: AdaptiveResult[] = [];
    for (const seed of seeds) {
      const result = await runAdaptive({
        client,
        attackerModel: values["attacker-model"],
        sandbox,
        agent,
        seed,
        rounds,
        feedback,
        maxUsd,
        episode: {
          ...(Object.keys(mandate).length ? { vault: { mandate } } : {}),
          ...(goal ? { goal } : {}),
        },
      });
      results.push(result);
      console.log(describe(result));
      // The payloads that worked are real attack text: they stay in the gitignored ratings folder.
      writeFileSync(join(outDir, `${seed.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
    }
    const hit = results.filter((r) => r.breached);
    const staticHit = results.filter((r) => r.staticBreached);
    console.log(
      `\n${results.length} seeds: ${staticHit.length} breached by the published text, ` +
        `${hit.length} within ${rounds} rewrites. Results in ${outDir}`,
    );
    // A clean result means little when the attacker model wrote nothing: say how often that happened.
    const tries = results.flatMap((r) => r.attempts);
    const wasted = tries.filter((a) => a.ruling === "invalid").length;
    console.log(
      `${tries.length - wasted} of ${tries.length} tries ran an episode; ${wasted} drafts were ` +
        `refused or invalid${wasted > tries.length / 4 ? " (the attacker model may be refusing: see the notes in the result files)" : ""}`,
    );
    console.log(
      "Key: X attack succeeded, I ignored, U unseen, G guard blocked, V vault blocked, N invalid draft, E agent error",
    );
  } finally {
    await sandbox.stop();
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
