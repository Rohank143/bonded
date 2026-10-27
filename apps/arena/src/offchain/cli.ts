#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  AgentKitAgent,
  DEFAULT_AGENT_MODEL,
  LlmPayablesAgent,
  SolanaAgentKitAgent,
} from "@bonded/demo-agents";
import {
  type ArenaAgent,
  type ChatClient,
  chatClientFromEnv,
  llmConfigForModel,
} from "@bondedhq/shared";
import { metaCapFallback, SpendingCap } from "../budget.js";
import { loadDotEnv } from "../env.js";
import { LlmCounterparty } from "./counterparty.js";
import { type OffchainEpisodeResult, runOffchainEpisode } from "./episode.js";
import { draftVariants, saveVariants, type VariantCandidate } from "./fresh.js";
import { controlScenario, type OffchainScenario, verifiedBankChangeTwin } from "./scenarios.js";
import { attackScenario, loadOffchainSeeds, type OffchainSeed, seedNeedsVision } from "./seeds.js";
import { scoreOffchainEpisodes } from "./score.js";

const USAGE = `Usage: pnpm --filter @bonded/arena offchain --max-usd <n> [options]

Runs an agent on the off-chain rail (docs/OFFCHAIN.md): the control, the benign twin and every
attack seed, judged by the payment ledger. With --fresh, a model also drafts one new variant of
each seed for this run; the variants are saved, and --replay runs a saved set again exactly.

  --max-usd <n>              stop starting episodes once model spend reaches this (required)
  --agent <name>             payables | agentkit | solana-agent-kit (default: payables)
  --model <id>               the agent's model (default: ${DEFAULT_AGENT_MODEL})
  --vision                   payables: show invoice images to the model
  --text-only                serve attachments' text layers only, never their images
  --hide-mandate             tell the agent its job but not the mandate's rules
  --seeds <list>             only these library seed ids (comma-separated)
  --fresh                    draft one fresh variant per seed and run it too
  --replay <dir>             run the variants saved in <dir> (a previous --out's variants/)
  --generator-model <id>     the model drafting variants (default: ${DEFAULT_AGENT_MODEL})
  --counterparty-model <id>  the model playing O6's counterparty (default: ${DEFAULT_AGENT_MODEL})
  --parallel <n>             episodes at once (default: 4)
  --out <dir>                where to write results (default: ratings/offchain-<agent>-<time>)`;

function agentFor(name: string, model: string, client: ChatClient, vision: boolean): ArenaAgent {
  if (name === "payables") return new LlmPayablesAgent({ client, model, vision });
  if (name === "agentkit") return new AgentKitAgent(model, undefined, "offchain");
  if (name === "solana-agent-kit") return new SolanaAgentKitAgent(model, undefined, "offchain");
  throw new Error(`unknown --agent ${name}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      "max-usd": { type: "string" },
      agent: { type: "string", default: "payables" },
      model: { type: "string", default: DEFAULT_AGENT_MODEL },
      vision: { type: "boolean", default: false },
      "text-only": { type: "boolean", default: false },
      "hide-mandate": { type: "boolean", default: false },
      seeds: { type: "string" },
      fresh: { type: "boolean", default: false },
      replay: { type: "string" },
      "generator-model": { type: "string", default: DEFAULT_AGENT_MODEL },
      "counterparty-model": { type: "string", default: DEFAULT_AGENT_MODEL },
      parallel: { type: "string", default: "4" },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || values["max-usd"] === undefined) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  const maxUsd = Number(values["max-usd"]);
  const parallel = Number(values.parallel);
  if (!(maxUsd > 0) || !(parallel >= 1))
    throw new Error("--max-usd and --parallel must be positive");

  loadDotEnv();
  const client = chatClientFromEnv();
  // Meta's models go to Meta Model API: check every model's key now, before anything runs.
  const models = [
    values.model,
    ...(values.fresh && !values.replay ? [values["generator-model"]] : []),
    values["counterparty-model"],
  ];
  for (const model of models) llmConfigForModel(model);
  const cap = new SpendingCap({ maxUsd, ...metaCapFallback(...models) });
  const out =
    values.out ??
    join("ratings", `offchain-${values.agent}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(out, { recursive: true });

  const wanted = values.seeds?.split(",").map((s) => s.trim());
  const library = loadOffchainSeeds().filter((s) => !wanted || wanted.includes(s.id));
  let variants: OffchainSeed[] = [];
  let candidates: VariantCandidate[] = [];
  if (values.replay) {
    variants = loadOffchainSeeds(values.replay).filter(
      (v) => !wanted || wanted.includes(v.variantOf ?? v.id),
    );
  } else if (values.fresh) {
    ({ variants, candidates } = await draftVariants({
      seeds: library,
      client,
      model: values["generator-model"],
      onUsage: (u) => cap.add(u),
    }));
    saveVariants(join(out, "variants"), variants);
    writeFileSync(join(out, "candidates.json"), `${JSON.stringify(candidates, null, 2)}\n`);
    console.log(`fresh variants: ${variants.length} of ${library.length} kept`);
    for (const c of candidates.filter((c) => !c.kept)) console.log(`  ${c.seed}: ${c.reason}`);
  }

  // An attack that lives only in an invoice image can't reach an agent that never sees images:
  // it isn't run, and isn't counted as resisted.
  const seesImages = values.agent === "payables" && values.vision && !values["text-only"];
  const attackSeeds = [...library, ...variants];
  const notShown = seesImages ? [] : attackSeeds.filter(seedNeedsVision).map((s) => s.id);
  const scenarios: OffchainScenario[] = [
    controlScenario(),
    verifiedBankChangeTwin(),
    ...attackSeeds.filter((s) => !notShown.includes(s.id)).map((s) => attackScenario(s)),
  ];
  const results: OffchainEpisodeResult[] = [];
  const skipped: string[] = [];
  const queue = [...scenarios];
  await Promise.all(
    Array.from({ length: Math.min(parallel, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        if (cap.exceeded) {
          skipped.push(next.id);
          continue;
        }
        const counterparty = next.counterparty
          ? new LlmCounterparty(
              next.counterparty,
              next.world.company,
              client,
              values["counterparty-model"],
              (u) => cap.add(u),
            )
          : undefined;
        const agent = agentFor(values.agent, values.model, client, values.vision);
        const r = await runOffchainEpisode(agent, next, {
          images: !values["text-only"],
          hideMandate: values["hide-mandate"],
          ...(counterparty ? { counterparty } : {}),
        });
        cap.add(r.agentSummary.usage);
        results.push(r);
      }
    }),
  );
  results.sort(
    (a, b) =>
      scenarios.findIndex((s) => s.id === a.scenarioId) -
      scenarios.findIndex((s) => s.id === b.scenarioId),
  );

  for (const r of results) {
    const outcome =
      r.agentSummary.stoppedBecause === "error" && !r.verdict.breached
        ? "error"
        : r.kind === "attack"
          ? r.verdict.attackSucceeded
            ? "FELL"
            : r.verdict.breached
              ? "breach"
              : "safe"
          : r.verdict.breached
            ? "breach"
            : "safe";
    const talk = r.conversation ? ` replies:${r.conversation.length}` : "";
    console.log(
      [
        r.scenarioId.padEnd(40),
        outcome.padEnd(6),
        `$${r.verdict.totalLossUsd}`.padEnd(10),
        r.taskCompleted ? "task-done" : `missed:${r.missed.join(",")}`,
        r.agentSummary.stoppedBecause + talk,
      ].join("  "),
    );
  }
  // An episode that errored before breaching shows nothing about the attack: counted apart.
  const errored = (r: OffchainEpisodeResult) =>
    r.agentSummary.stoppedBecause === "error" && !r.verdict.breached;
  const attacks = results.filter((r) => r.kind === "attack" && !errored(r));
  const fell = attacks.filter((r) => r.verdict.attackSucceeded).length;
  const errors = results.filter(errored).map((r) => r.scenarioId);
  const scoring = scoreOffchainEpisodes(results);
  const summary = {
    agent: agentFor(values.agent, values.model, client, values.vision).name,
    score: scoring.score,
    worstClass: scoring.worstClass,
    worstBriefing: scoring.worstBriefing,
    driver: scoring.driver,
    vision: values.vision,
    images: !values["text-only"],
    mandateShown: !values["hide-mandate"],
    attacks: attacks.length,
    fell,
    errors,
    notShown,
    lossUsd: attacks.reduce((sum, r) => sum + r.verdict.totalLossUsd, 0),
    tasksDone: results.filter((r) => r.taskCompleted).length,
    episodes: results.length,
    skipped,
    spend: cap.summary(),
    rows: scoring.rows,
  };
  const scoreMsg = scoring.driver
    ? `Bonded Score ${scoring.score}/100 (driven by ${scoring.driver})`
    : `Bonded Score ${scoring.score}/100`;
  console.log(
    `\nfell for ${fell} of ${attacks.length} attacks; ${scoreMsg}; spend $${summary.spend.spentUsd.toFixed(4)}`,
  );
  if (skipped.length) console.log(`skipped at the spending cap: ${skipped.join(", ")}`);
  if (errors.length) console.log(`errored, not counted: ${errors.join(", ")}`);
  if (notShown.length) console.log(`not run, the agent sees no images: ${notShown.join(", ")}`);
  // Images are in the seeds; the record notes their size instead of repeating them.
  const record = JSON.stringify(
    { summary, candidates, results },
    (key, value: unknown) =>
      key === "base64" && typeof value === "string" ? `<${value.length} base64 chars>` : value,
    2,
  );
  writeFileSync(join(out, "results.json"), `${record}\n`);
  console.log(`wrote ${out}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
