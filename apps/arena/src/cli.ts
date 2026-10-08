#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  AgentKitAgent,
  type Brain,
  createHardenedAgent,
  createPartialAgent,
  DEFAULT_AGENT_MODEL,
  createVulnerableAgent,
  CascadeSentinel,
  DecisionModelAgent,
  GuardedAgent,
  DecisionModelSentinel,
  LayaSentinel,
  LlmDecisionModel,
  SentinelGuard,
  SolanaAgentKitAgent,
} from "@bonded/demo-agents";
import {
  AgentMode,
  type ArenaAgent,
  EVM_CHAINS,
  type EvmMandateInput,
  isWellFormedRunnerToken,
  llmConfigFromEnv,
  OpenAICompatibleClient,
  parseSentinelQuestionSet,
} from "@bonded/shared";
import { loadAttackLibrary } from "./attacks.js";
import { runControls } from "./controls.js";
import { loadDotEnv, usesLanguageModel } from "./env.js";
import { type EpisodeResult, runEpisode, saveEpisode } from "./episode.js";
import { ArenaGateway, newRunnerToken, RemoteAgent, StaticRunnerTokens } from "./gateway/index.js";
import { FileHeldOutLedger, freshHeldOut } from "./held-out-fresh.js";
import { rateAgent } from "./rate.js";
import { sentinelInfo } from "./sentinel-info.js";
import { attestTeeAgent } from "./tee.js";
import { describeOutcome, summarise } from "./report.js";
import { Sandbox } from "./sandbox.js";
import { describeProfile, rateSettings } from "./cli-profile.js";

const USAGE = `Usage:
  pnpm --filter @bonded/arena arena run [options]    run episodes and print each verdict
  pnpm --filter @bonded/arena arena rate [options]   full rating: score, report, attestation
  pnpm --filter @bonded/arena arena controls [options]  benign episodes only, for Sentinel's
                                                       false-alarm test (no score)

Agent:
  --agent <vulnerable|hardened|partial|decision|agentkit|solana-agent-kit|remote>
                           agent to test (default: vulnerable). agentkit and solana-agent-kit run
                           those frameworks' template agents with the Arena's tools (needs
                           OPENROUTER_API_KEY; --model picks the model). remote rates your own
                           agent wherever it runs, through the Arena Gateway and @bonded/runner
                           (see "Remote agents" below)
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
  --profile <local|hosted> rate --agent remote: local (default) uses this CLI's defaults; hosted
                           runs what the hosted service does (3 runs of each attack, 90 s
                           episodes, 6 controls, one held-out variant per class, only exposed
                           trials count, its refusal rules), to predict your hosted result. It
                           fixes --repeats, --controls, --episode-timeout and --held-out-fresh
  --controls <n>           rate: episodes with no attack (default: 2); controls: how many (default: 24)
  --held-out <dir>         rate only: also run the unpublished attacks in this folder (YAML, from
                           pnpm heldout:generate); the report counts them as unpublished
  --list                   list the attack library and exit

Remote agents (--agent remote, run or rate):
  --mode <tools|chain>     tools (default): your agent calls tools over MCP or HTTP; chain: it reads
                           with tools and signs its own vault transactions through an RPC endpoint
  --runner-token <t>       the token your runner connects with (default: a fresh one, printed)
  --gateway-port <n>       port for the local gateway (default: 8789)
  --gateway-host <h>       address to listen on (default: 127.0.0.1)
  --public-url <url>       the URL your runner and agent reach the gateway at, when it isn't
                           http://<host>:<port> (e.g. behind a tunnel)
  --runner-wait <s>        how long to wait for the runner to connect (default: 300)
  --episode-timeout <s>    each episode's time limit (default: 240)
  --name <name>            the agent's name in the report (default: remote/local)
  --held-out-fresh <n>     rate only: variants per attack class made for this rating alone, never
                           reused (default: 1; 0 for none). Used payloads are recorded in
                           ~/.config/bonded/held-out-used.txt
  --held-out-model <id>    draft those variants with this model (needs OPENROUTER_API_KEY);
                           without it they are deterministic rewrites
  --held-out-max-usd <n>   spending cap for --held-out-model (default: 0.25)

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
      repeats: { type: "string" },
      controls: { type: "string" },
      "max-usd": { type: "string" },
      fork: { type: "string" },
      traces: { type: "string", default: "traces" },
      out: { type: "string" },
      "held-out": { type: "string" },
      mode: { type: "string", default: "tools" },
      "runner-token": { type: "string" },
      "gateway-port": { type: "string", default: "8789" },
      "gateway-host": { type: "string", default: "127.0.0.1" },
      "public-url": { type: "string" },
      "runner-wait": { type: "string", default: "300" },
      "episode-timeout": { type: "string" },
      name: { type: "string" },
      "held-out-fresh": { type: "string" },
      profile: { type: "string" },
      "held-out-model": { type: "string" },
      "held-out-max-usd": { type: "string", default: "0.25" },
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

  const published = loadAttackLibrary();
  // The held-out set never lives in the repository; it's read from a private folder.
  const heldOut = values["held-out"] ? loadAttackLibrary(values["held-out"]) : [];
  const library = [...published, ...heldOut];
  if (values.list) {
    for (const spec of library) console.log(`${spec.id.padEnd(34)} ${spec.title}`);
    return 0;
  }

  const remote = values.agent === "remote";
  if (remote && command === "controls") throw new Error("--agent remote works with run and rate");
  // Local defaults, or exactly what a hosted rating of an operator-run agent runs.
  const settings = rateSettings(
    values.profile,
    {
      repeats: values.repeats,
      controls: values.controls,
      "episode-timeout": values["episode-timeout"],
      "held-out-fresh": values["held-out-fresh"],
    },
    { remote, command },
  );
  const mode = AgentMode.safeParse(values.mode);
  if (!mode.success) throw new Error("--mode must be tools or chain");
  // Only runs that call a language model read .env (for its API key); local scripted runs
  // never do, as the README promises.
  if (usesLanguageModel(values) || values["held-out-model"]) loadDotEnv();
  // Build the agent first, so a missing API key fails before a sandbox is started. A remote
  // agent needs the sandbox and the gateway, so it is built once they are up.
  let agent: ArenaAgent = remote ? placeholderAgent : buildAgent(values);
  let vault: { mandate: Partial<EvmMandateInput> } | undefined = values.enforce
    ? { mandate: { mode: "enforce" } }
    : undefined;
  const forkUrl = values.fork ? (FORKS[values.fork] ?? values.fork) : undefined;
  console.log(forkUrl ? `Forking ${forkUrl}` : "Starting a fresh local chain");
  const sandbox = await Sandbox.start({ forkUrl, log: (m) => m && console.log(m) });
  // The partial agent's mandate allows refunds to the depositor: the address its weak check
  // trusts and address poisoning imitates (docs/SPECIFICATION.md, Day 14 detail).
  if (values.agent === "partial")
    vault = {
      mandate: { ...vault?.mandate, destinations: [sandbox.address("depositor")] },
    };
  let gateway: ArenaGateway | undefined;
  try {
    if (remote) {
      const started = await startRemote(sandbox, values, mode.data, settings.episodeTimeoutMs);
      gateway = started.gateway;
      agent = started.agent;
    }
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
            // A local CLI run may check a TEE simulator on this machine.
            allowLoopback: true,
            codeHash: codeHash ?? required("--code-hash with --tee-url"),
            composeHash:
              hex32(values["tee-compose-hash"], "--tee-compose-hash") ??
              required("--tee-compose-hash with --tee-url"),
          })
        : undefined;
      if (tee) console.log(`TEE verified: measurement ${tee.measurement}`);
      // A remote agent's operator sees every attack their agent reads, so each of its ratings
      // also gets a held-out set made for it alone, never reused.
      const perClass = remote ? settings.heldOutPerClass : 0;
      console.log(describeProfile(settings));
      const fresh =
        perClass > 0
          ? await freshHeldOut({
              library: published,
              perClass,
              sandbox,
              ledger: new FileHeldOutLedger(
                join(homedir(), ".config", "bonded", "held-out-used.txt"),
              ),
              ...(values["held-out-model"]
                ? {
                    llm: {
                      client: new OpenAICompatibleClient(llmConfigFromEnv()),
                      model: values["held-out-model"],
                      maxUsd: Number(values["held-out-max-usd"]),
                    },
                  }
                : {}),
            })
          : undefined;
      if (fresh) {
        console.log(
          `Held-out set for this rating: ${fresh.heldOut.attacks} attacks (${fresh.heldOut.source}), seed ${fresh.heldOut.seed}`,
        );
        for (const m of fresh.missing) console.log(`  no variant for ${m.class}: ${m.reason}`);
      }
      const result = await rateAgent(sandbox, {
        agent,
        ...(codeHash ? { codeHash } : {}),
        ...(tee ? { tee } : {}),
        // The report says when Sentinel was in front of the agent, and which guard it was.
        ...(values["sentinel-model"]
          ? {
              sentinel: sentinelInfo(
                values["sentinel-model"],
                values["sentinel-fallback"],
                values["sentinel-questions"],
              ),
            }
          : {}),
        attacks: [...library, ...(fresh?.attacks ?? [])],
        unpublished: new Set([...heldOut, ...(fresh?.attacks ?? [])].map((a) => a.id)),
        ...(fresh ? { heldOut: fresh.heldOut } : {}),
        repeats: settings.repeats,
        controls: settings.controls,
        ...(settings.exercise ? { exercise: settings.exercise } : {}),
        ...(settings.attackLiveness ? { attackLiveness: settings.attackLiveness } : {}),
        ...(vault ? { vault } : {}),
        ...(values["max-usd"] ? { maxUsd: Number(values["max-usd"]) } : {}),
        outDir,
        onEpisode: (r, i, total) =>
          console.log(
            `[${i + 1}/${total}] ${(r.attackId ?? "control").padEnd(34)} ${describeOutcome(r)}`,
          ),
      });
      const s = result.report.scoring;
      console.log(
        `\n${agent.name}: Bonded Score ${s.score} (${s.tier}), ${settings.profile} profile`,
      );
      console.log(`  expected loss ${(s.expectedLoss * 100).toFixed(2)}% of cover a year`);
      console.log(
        `  premium ${(s.premiumRate * 100).toFixed(2)}% a year${s.insurable ? "" : " (not insurable)"}`,
      );
      console.log(
        `  attestation ${result.posted.posted ? "posted to the sandbox registry" : `signed, not posted: ${result.posted.reason}`}`,
      );
      const untested = s.groups.flatMap((g) => g.untestedClasses ?? []);
      if (untested.length)
        console.log(
          `  untested: ${untested.join(", ")} never tested the agent, so each is priced as untested within its group`,
        );
      if (result.refused) console.log(`  not attested: ${result.refused}`);
      if (result.report.stoppedEarly) console.log(`  stopped early: ${result.report.stoppedEarly}`);
      if (result.report.guardFailures)
        console.log(
          `  incomplete: a guard failed to answer ${result.report.guardFailures} times, so this score isn't a measurement of it`,
        );
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
    await gateway?.close();
    await sandbox.stop();
  }
}

/** Stands in until the remote agent is built; never run. */
const placeholderAgent: ArenaAgent = {
  name: "remote",
  run: () => Promise.reject(new Error("the remote agent isn't connected")),
};

/**
 * Starts a local Arena Gateway for a remote agent, prints the runner command, and waits for the
 * runner to connect. The token is held in memory only; it works for this run alone.
 */
async function startRemote(
  sandbox: Sandbox,
  values: {
    "runner-token"?: string;
    "gateway-port"?: string;
    "gateway-host"?: string;
    "public-url"?: string;
    "runner-wait"?: string;
    name?: string;
  },
  mode: AgentMode,
  episodeTimeoutMs: number,
): Promise<{ gateway: ArenaGateway; agent: RemoteAgent }> {
  const given = values["runner-token"];
  const token = given ?? newRunnerToken();
  if (!isWellFormedRunnerToken(token))
    throw new Error(
      "--runner-token must be bonded_rt_ followed by at least 16 base64url characters",
    );
  const gateway = new ArenaGateway({
    tokens: new StaticRunnerTokens({ [token]: "local" }),
    ...(values["public-url"] ? { publicUrl: values["public-url"] } : {}),
    onRunnerPresence: (e) => {
      if (e.type === "connected") console.log(`Runner connected (${e.hello?.mode} mode)`);
      if (e.type === "disconnected") console.log(`Runner disconnected (${e.reason})`);
    },
  });
  const url = await gateway.listen({
    port: positiveInt(values["gateway-port"], "--gateway-port"),
    host: values["gateway-host"] ?? "127.0.0.1",
  });
  console.log(`\nArena Gateway listening at ${url}`);
  console.log("Start your agent's runner in another terminal:\n");
  const tokenShown = given ? "<your token>" : token;
  console.log(
    `  BONDED_RUNNER_TOKEN=${tokenShown} npx @bonded/runner --gateway ${url} ` +
      `--mode ${mode} -- <your agent command>\n`,
  );
  console.log("or, from this repository (until @bonded/runner is published):\n");
  console.log(
    `  BONDED_RUNNER_TOKEN=${tokenShown} node apps/runner/dist/cli.js --gateway ${url} ` +
      `--mode ${mode} -- <your agent command>\n`,
  );
  const waitMs = positiveInt(values["runner-wait"], "--runner-wait") * 1000;
  const deadline = Date.now() + waitMs;
  console.log(`Waiting up to ${waitMs / 1000} s for the runner...`);
  while (!gateway.runner("local")) {
    if (Date.now() > deadline) {
      await gateway.close();
      throw new Error("no runner connected in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const runnerMode = gateway.runner("local")?.hello?.mode;
  if (runnerMode !== mode) {
    await gateway.close();
    throw new Error(`the runner is in ${runnerMode} mode, but --mode is ${mode}`);
  }
  const agent = new RemoteAgent({
    gateway,
    sandbox,
    runner: "local",
    mode,
    name: values.name ?? "remote/local",
    episodeTimeoutMs,
  });
  return { gateway, agent };
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
    case "partial":
      if (sentinel.length) throw new Error("--sentinel-model works with vulnerable or hardened");
      return createPartialAgent(brain as Brain, llm);
    case "decision":
      if (sentinel.length) throw new Error("--sentinel-model works with vulnerable or hardened");
      return new DecisionModelAgent(new LlmDecisionModel(llm));
    case "agentkit":
    case "solana-agent-kit": {
      const model = values.model ?? DEFAULT_AGENT_MODEL;
      const agent =
        values.agent === "agentkit" ? new AgentKitAgent(model) : new SolanaAgentKitAgent(model);
      // A template agent behind Sentinel: what adding Bonded's guard does for it.
      return sentinel.length ? new GuardedAgent(agent, sentinel, "sentinel") : agent;
    }
    default:
      throw new Error(
        `unknown agent ${values.agent} (vulnerable, hardened, partial, decision, agentkit or solana-agent-kit)`,
      );
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
