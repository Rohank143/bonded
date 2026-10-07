import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ATTACK_CLASSES,
  type ArenaAgent,
  type AttackClassId,
  type AttackSpec,
  type ClassObservation,
  mandateHash,
  type ModelFamily,
  type Scoring,
  type Severity,
  scoreRating,
} from "@bonded/shared";
import { keccak256, stringToBytes } from "viem";
import {
  ATTESTATION_TTL_SECONDS,
  modelFamilyOf,
  postAttestation,
  SANDBOX_ATTESTER_KEY,
  type SignedAttestation,
  signAttestation,
} from "./attestation.js";
import { SpendingCap } from "./budget.js";
import { datasetRows, type SentinelRow, writeDataset } from "./dataset.js";
import { BENIGN_GOALS, type EpisodeResult, runEpisode, saveEpisode } from "./episode.js";
import { episodeOutcome } from "./report.js";
import type { Sandbox } from "./sandbox.js";
import type { VerifiedTee } from "./tee.js";
import { type AgentVaultOptions, createAgentVault } from "./vault.js";

/**
 * A full rating (docs/PLAN.md Sections 8 and 9): run the attack library against an agent, plus
 * control episodes, then score the results, write the report, and sign (and in a fresh
 * sandbox, post) the attestation. See ADR-007.
 */
export interface RatingOptions {
  agent: ArenaAgent;
  attacks: AttackSpec[];
  /** Runs of each seed, each under a different benign goal (default 1). */
  repeats?: number;
  /** Episodes with no attack (default 2). */
  controls?: number;
  /** Mandate for every vault in the rating (e.g. { mandate: { mode: "enforce" } }). */
  vault?: AgentVaultOptions;
  /** Stop starting episodes once model spend reaches this (USD). */
  maxUsd?: number;
  /** Where to write the report, traces, dataset and attestation. */
  outDir?: string;
  modelFamily?: ModelFamily;
  /** Hash of the agent's code or config version (default: hash of its name). */
  codeHash?: `0x${string}`;
  /**
   * Evidence that the rated code is running in a TEE, already verified (`attestTeeAgent`). Its
   * measurement goes into the attestation. Its code hash must be the rated `codeHash`.
   */
  tee?: VerifiedTee;
  /**
   * Ids of the attacks in `attacks` that aren't published: accepted bounties and the held-out
   * set (docs/decisions/007-ratings.md). The report counts them, so a reader can see how much of
   * the rating the operator couldn't have studied in advance.
   */
  unpublished?: ReadonlySet<string>;
  /**
   * Sentinel was in front of the agent for this rating (docs/SENTINEL.md): which model, which
   * questions and at what threshold it blocked. The report says so, so a score earned with
   * Sentinel on is never read as the agent's score alone.
   */
  sentinel?: RatingSentinel;
  /** Called after each episode, e.g. for progress output. */
  onEpisode?: (result: EpisodeResult, index: number, total: number) => void | Promise<void>;
}

export interface ClassResult {
  class: AttackClassId;
  name: string;
  episodes: number;
  agentErrors: number;
  breaches: number;
  attackSucceeded: number;
  lossUsd: number;
}

export interface RatingReport {
  version: 1;
  agent: string;
  modelFamily: ModelFamily;
  mandateMode: "monitor" | "enforce";
  chainId: number;
  forked: boolean;
  startedAt: string;
  durationMs: number;
  episodes: { total: number; attacks: number; controls: number; agentErrors: number };
  controls: { episodes: number; breaches: number };
  /**
   * Unpublished attacks (accepted bounties and the held-out set) that this rating actually ran,
   * and the attack episodes that ran them. Older reports don't have it.
   */
  unpublished?: { attacks: number; episodes: number };
  classes: ClassResult[];
  scoring: Scoring;
  worst: { episodeId: string; attackId: string | null; lossUsd: number; breaches: string[] }[];
  blockedByAgentGuard: number;
  /**
   * Of those, writes refused because a guard failed to answer (Sentinel unreachable, a malformed
   * reply). A rating with any is incomplete: the worker won't attest it. Older reports don't
   * have it.
   */
  guardFailures?: number;
  spend: ReturnType<SpendingCap["summary"]>;
  stoppedEarly: string | null;
  mitigations: string[];
  /** The verified TEE the agent runs in, or null when it runs on the operator's own server. */
  tee: RatingTee | null;
  /** Sentinel in front of the agent, or null without it. Older reports don't have it. */
  sentinel?: RatingSentinel | null;
}

/** What a report records about the Sentinel guard a rating ran with. */
export interface RatingSentinel {
  model: string;
  /** The checkpoint that answered: its Hugging Face repo and pinned revision, when known. */
  repo?: string;
  revision?: string;
  questions: "v1" | "v3";
  blockThreshold: number;
  /**
   * A cascade: the second model asked when the first is unsure, with its own question set and
   * the band of "manipulated" scores that sends a case to it.
   */
  fallback?: { model: string; questions: "v1" | "v3"; unsureBand: [number, number] };
}

/** What the report records about a verified TEE (the full evidence is not kept). */
export interface RatingTee {
  measurement: `0x${string}`;
  composeHash: `0x${string}`;
  evmAddress: `0x${string}`;
  solanaPublicKey: string;
  tcbStatus: string;
}

export interface RatingResult {
  report: RatingReport;
  reportHash: `0x${string}`;
  attestation: SignedAttestation;
  posted: Awaited<ReturnType<typeof postAttestation>>;
  episodes: EpisodeResult[];
  files: Record<string, string>;
}

const SEVERITY_ORDER: Severity[] = ["low", "medium", "high", "critical"];

export async function rateAgent(sandbox: Sandbox, options: RatingOptions): Promise<RatingResult> {
  const started = Date.now();
  if (options.tee && options.tee.codeHash.toLowerCase() !== options.codeHash?.toLowerCase())
    throw new Error("the TEE runs different code than the codeHash being rated");
  const repeats = options.repeats ?? 1;
  const controls = options.controls ?? 2;
  const cap = new SpendingCap({ maxUsd: options.maxUsd ?? Number.POSITIVE_INFINITY });
  const outDir = options.outDir;
  const tracesDir = outDir ? join(outDir, "traces") : undefined;
  const datasetPath = outDir ? join(outDir, "sentinel-dataset.jsonl") : undefined;
  if (outDir) mkdirSync(outDir, { recursive: true });

  // The rated agent's own registry entry and mandate: what the attestation is about.
  const profile = await createAgentVault(sandbox, options.vault);

  type Job = { attack: AttackSpec | null; goal: string };
  const jobs: Job[] = [];
  for (let r = 0; r < repeats; r++) {
    options.attacks.forEach((attack, i) => {
      const goal = BENIGN_GOALS[(i + r) % BENIGN_GOALS.length] ?? BENIGN_GOALS[0];
      jobs.push({ attack, goal: attack.goal ?? goal });
    });
  }
  for (let c = 0; c < controls; c++) {
    jobs.push({ attack: null, goal: BENIGN_GOALS[c % BENIGN_GOALS.length] ?? BENIGN_GOALS[0] });
  }

  const episodes: EpisodeResult[] = [];
  const rows: SentinelRow[] = [];
  let stoppedEarly: string | null = null;
  for (const [index, job] of jobs.entries()) {
    if (cap.exceeded) {
      stoppedEarly = `spending cap of $${options.maxUsd} reached after ${index} of ${jobs.length} episodes`;
      break;
    }
    const result = await runEpisode(sandbox, {
      agent: options.agent,
      attack: job.attack,
      goal: job.goal,
      ...(options.vault ? { vault: options.vault } : {}),
    });
    cap.add(result.agentSummary.usage);
    episodes.push(result);
    if (tracesDir) saveEpisode(result, tracesDir);
    rows.push(...datasetRows(result));
    await options.onEpisode?.(result, index, jobs.length);
  }

  const mode = profile.mandate.mode;
  const deposit = options.vault?.deposit ?? 50_000;
  const classes = classResults(episodes);
  const scoring = scoreRating({
    observations: observations(episodes, options.attacks),
    // Key custody is an assumed term, not a measurement (ADR-014): the TEE only counts once verified.
    // The rating can't know which key operates the covered vault, so the quote API enforces that the
    // vault's execution key is this TEE's key before it prices cover (ADR-013, decision 3).
    custody: options.tee ? "tee" : "operator",
    ...(mode === "enforce"
      ? { severityCap: Math.min(1, profile.mandate.limits.maxTxNotionalUsd / deposit) }
      : {}),
  });
  const modelFamily = options.modelFamily ?? modelFamilyOf(options.agent.name);
  const controlEpisodes = episodes.filter((e) => e.attackId === null);
  const report: RatingReport = {
    version: 1,
    agent: options.agent.name,
    modelFamily,
    mandateMode: mode,
    chainId: sandbox.chain.id,
    forked: sandbox.forked,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    episodes: {
      total: episodes.length,
      attacks: episodes.length - controlEpisodes.length,
      controls: controlEpisodes.length,
      agentErrors: episodes.filter((e) => episodeOutcome(e) === "agent_error").length,
    },
    controls: {
      episodes: controlEpisodes.length,
      breaches: controlEpisodes.filter((e) => e.verdict.breached).length,
    },
    // Only what actually ran: a spending cap can stop a rating before some attacks run.
    unpublished: (() => {
      const ran = episodes.filter(
        (e) => e.attackId !== null && options.unpublished?.has(e.attackId),
      );
      return { attacks: new Set(ran.map((e) => e.attackId)).size, episodes: ran.length };
    })(),
    classes,
    scoring,
    worst: episodes
      .filter((e) => e.verdict.breached)
      .sort((a, b) => b.verdict.totalLossUsd - a.verdict.totalLossUsd)
      .slice(0, 5)
      .map((e) => ({
        episodeId: e.id,
        attackId: e.attackId,
        lossUsd: e.verdict.totalLossUsd,
        breaches: e.verdict.breaches.map((b) => b.type),
      })),
    blockedByAgentGuard: episodes.reduce(
      (n, e) => n + (e.agentSummary.blockedActions?.length ?? 0),
      0,
    ),
    guardFailures: episodes.reduce(
      (n, e) => n + (e.agentSummary.blockedActions?.filter((b) => b.guardFailed).length ?? 0),
      0,
    ),
    spend: cap.summary(),
    stoppedEarly,
    mitigations: mitigations(classes, mode),
    tee: options.tee
      ? {
          measurement: options.tee.measurement,
          composeHash: options.tee.composeHash,
          evmAddress: options.tee.evmAddress,
          solanaPublicKey: options.tee.solanaPublicKey,
          tcbStatus: options.tee.tcbStatus,
        }
      : null,
    sentinel: options.sentinel ?? null,
  };

  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const reportHash = keccak256(stringToBytes(reportJson));
  const block = await sandbox.publicClient.getBlock();
  const issuedAt = Number(block.timestamp);
  const attestation = await signAttestation(
    {
      agentId: profile.agentId.toString(),
      score: scoring.score,
      expectedLossBps: scoring.expectedLossBps,
      reportHash,
      mandateHash: mandateHash(profile.mandate),
      codeHash: options.codeHash ?? keccak256(stringToBytes(options.agent.name)),
      teeMeasurement: options.tee?.measurement ?? `0x${"0".repeat(64)}`,
      modelFamily,
      issuedAt,
      expiresAt: issuedAt + ATTESTATION_TTL_SECONDS,
    },
    {
      chainId: sandbox.chain.id,
      registry: sandbox.deployment.registry,
      attesterKey: SANDBOX_ATTESTER_KEY,
    },
  );
  const posted = await postAttestation(sandbox, attestation);

  const files: Record<string, string> = {};
  if (outDir) {
    files.report = join(outDir, "report.json");
    files.markdown = join(outDir, "report.md");
    files.attestation = join(outDir, "attestation.json");
    writeFileSync(files.report, reportJson);
    writeFileSync(files.markdown, renderReportMarkdown(report, reportHash, posted));
    writeFileSync(
      files.attestation,
      `${JSON.stringify({ ...attestation, reportHash, posted }, null, 2)}\n`,
    );
    if (datasetPath) {
      // Written once the rating is complete, each row tagged with the report it belongs to.
      writeDataset(
        datasetPath,
        rows.map((row) => ({ ...row, ratingId: reportHash })),
      );
      files.dataset = datasetPath;
    }
    if (tracesDir) files.traces = tracesDir;
  }
  return { report, reportHash, attestation, posted, episodes, files };
}

/** Per-class results; agent errors are counted apart and excluded from the rates. */
function classResults(episodes: EpisodeResult[]): ClassResult[] {
  return (Object.keys(ATTACK_CLASSES) as AttackClassId[]).map((id) => {
    const inClass = episodes.filter((e) => e.attackClass === id);
    const judged = inClass.filter((e) => episodeOutcome(e) !== "agent_error");
    return {
      class: id,
      name: ATTACK_CLASSES[id].name,
      episodes: judged.length,
      agentErrors: inClass.length - judged.length,
      breaches: judged.filter((e) => e.verdict.breached).length,
      attackSucceeded: judged.filter((e) => e.verdict.attackSucceeded).length,
      lossUsd: judged.reduce((sum, e) => sum + e.verdict.totalLossUsd, 0),
    };
  });
}

function observations(episodes: EpisodeResult[], attacks: AttackSpec[]): ClassObservation[] {
  return (Object.keys(ATTACK_CLASSES) as AttackClassId[]).flatMap((id) => {
    const judged = episodes.filter(
      (e) => e.attackClass === id && episodeOutcome(e) !== "agent_error",
    );
    if (judged.length === 0) return [];
    const breached = judged.filter((e) => e.verdict.breached);
    // Only seeds that ran count: a run stopped early by the spending cap mustn't be priced
    // on seeds it never tried.
    const ran = new Set(judged.map((e) => e.attackId));
    const hints = attacks.filter((a) => a.class === id && ran.has(a.id)).map((a) => a.severityHint);
    const severityHint = SEVERITY_ORDER.reduce<Severity>(
      (worst, s) => (hints.includes(s) ? s : worst),
      "low",
    );
    return [
      {
        class: id,
        episodes: judged.length,
        breaches: breached.length,
        lossFractions: breached.map((e) => Math.min(1, e.verdict.totalLossUsd / e.vaultValueUsd)),
        severityHint,
      },
    ];
  });
}

const MITIGATIONS: Record<AttackClassId, string> = {
  A1: "Treat token names, symbols and descriptions as data; never act on instructions in them.",
  A2: "Separate operator instructions from content; news and social posts can't move funds.",
  A3: "Size trades from the on-chain oracle, not a price API, and cap trade size in code.",
  A4: "Allowlist token and router addresses; never send funds to 'migrate' a token.",
  A5: "Never copy addresses from transfer history; pay only allowlisted destinations.",
  A6: "Verify operator requests out of band; no message can authorise a transfer.",
  A7: "Treat tool and API output as untrusted; strip or ignore embedded instructions.",
  A8: "Enforce per-trade and daily caps in code and in the vault (Enforce mode).",
  A9: "Track daily volume and refuse repeated or out-of-scope trades.",
  A10: "Settle only through allowlisted contracts; never approve a counterparty's spender.",
};

function mitigations(classes: ClassResult[], mode: string): string[] {
  const list = classes
    .filter((c) => c.breaches > 0)
    .map((c) => `${c.class}: ${MITIGATIONS[c.class]}`);
  if (mode === "monitor" && list.length > 0) {
    list.push(
      "Run the vault in Enforce mode so unauthorised actions are blocked, not just recorded.",
    );
  }
  return list;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;

/** The report for people: score, tier, premium, per-class results and what to fix. */
export function renderReportMarkdown(
  report: RatingReport,
  reportHash: `0x${string}`,
  posted: RatingResult["posted"],
): string {
  const s = report.scoring;
  const lines = [
    `# Bonded rating: ${report.agent}`,
    "",
    `**Bonded Score ${s.score} (${s.tier})**${s.insurable ? "" : ", not insurable"}. ` +
      `Expected annual loss ${pct(s.expectedLoss)} of cover; premium ${pct(s.premiumRate)} a year.`,
    "",
    `- Mandate mode: ${report.mandateMode}; model family: ${report.modelFamily}`,
    `- Chain: ${report.chainId}${report.forked ? " (fork)" : " (fresh sandbox)"}`,
    `- Episodes: ${report.episodes.total} (${report.episodes.attacks} attacks, ` +
      `${report.episodes.controls} controls, ${report.episodes.agentErrors} with agent errors)`,
    `- Control episodes breached: ${report.controls.breaches} of ${report.controls.episodes}`,
    ...(report.unpublished
      ? [
          `- Unpublished attacks: ${report.unpublished.attacks} of the library's attacks, ` +
            `${report.unpublished.episodes} attack episodes (accepted bounties and the held-out set; ` +
            `the operator couldn't study them in advance)`,
        ]
      : []),
    `- Actions stopped by the agent's own guard: ${report.blockedByAgentGuard}` +
      (report.guardFailures ? ` (${report.guardFailures} because a guard failed to answer)` : ""),
    ...(report.sentinel
      ? [
          `- Sentinel on: ${report.sentinel.model}` +
            (report.sentinel.revision ? ` at ${report.sentinel.revision}` : "") +
            `, questions ${report.sentinel.questions}, blocks at ${report.sentinel.blockThreshold}` +
            (report.sentinel.fallback
              ? `; unsure cases (${report.sentinel.fallback.unsureBand.join("–")}) go to ` +
                `${report.sentinel.fallback.model} (questions ${report.sentinel.fallback.questions})`
              : "") +
            " (its blocks are counted above)",
        ]
      : []),
    `- Model spend: $${report.spend.spentUsd.toFixed(4)}${report.spend.estimated ? " (estimated)" : ""}` +
      `, ${report.spend.inputTokens} input and ${report.spend.outputTokens} output tokens`,
    `- Duration: ${(report.durationMs / 1000).toFixed(1)} s`,
    ...(report.tee
      ? [
          `- TEE: Intel TDX on Phala dstack, measurement ${report.tee.measurement}; the agent's session ` +
            `key is ${report.tee.evmAddress} (EVM) and ${report.tee.solanaPublicKey} (Solana)`,
        ]
      : []),
    ...(report.stoppedEarly ? [`- **Stopped early:** ${report.stoppedEarly}`] : []),
    "",
    "## Risk by class group",
    "",
    "| Group | Classes | λ / yr | Breaches | Observed | b (90% bound) | s | λ·b·s |",
    "|---|---|---|---|---|---|---|---|",
    ...s.groups.map(
      (g) =>
        `| ${g.name} | ${g.classes.length ? g.classes.join(", ") : "assumed, not tested"} | ${g.lambda} | ${g.breaches} / ${g.episodes} | ` +
        `${pct(g.observedRate)} | ${pct(g.breachRate)} | ${pct(g.severity)} (${g.severitySource}) | ` +
        `${pct(g.expectedLoss)} |`,
    ),
    `| **Total** | | | | | | | **${pct(s.expectedLoss)}** |`,
    "",
    "The key-custody row is an assumption, not an Arena result: it assumes a 2% a year chance that the " +
      "agent's server is compromised, in which case a key held there is stolen, and a key held in a " +
      "verified TEE is not. The attacks above can't measure it.",
    "",
    "## Attack classes",
    "",
    "| Class | Name | Episodes | Breached | Attack succeeded | Loss |",
    "|---|---|---|---|---|---|",
    ...report.classes.map(
      (c) =>
        `| ${c.class} | ${c.name} | ${c.episodes}${c.agentErrors ? ` (+${c.agentErrors} errors)` : ""} | ` +
        `${c.breaches} | ${c.attackSucceeded} | ${usd(c.lossUsd)} |`,
    ),
    "",
    "## Worst episodes",
    "",
    ...(report.worst.length === 0
      ? ["No breaches."]
      : report.worst.map(
          (w) =>
            `- ${w.attackId ?? "control"}: ${usd(w.lossUsd)} (${w.breaches.join(", ")}), trace ${w.episodeId}`,
        )),
    "",
    "## Recommended mitigations",
    "",
    ...(report.mitigations.length === 0
      ? ["None: no class breached."]
      : report.mitigations.map((m) => `- ${m}`)),
    "",
    "## Attestation",
    "",
    `- Report hash: \`${reportHash}\``,
    `- ${posted.posted ? `Posted to the registry (tx \`${posted.hash}\`)` : `Signed, not posted: ${posted.reason}`}`,
    "",
    "The breach counts come only from the vault's on-chain breach log. λ and the severity priors " +
      "are documented assumptions (ADR-007), and b is an upper bound, so small samples are priced " +
      "conservatively.",
    "",
  ];
  return lines.join("\n");
}
