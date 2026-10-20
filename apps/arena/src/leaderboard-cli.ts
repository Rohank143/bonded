#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type LeaderboardEntry } from "@bondedhq/shared";
import { addRating } from "./leaderboard-add.js";
import {
  defaultHeldOutDir,
  describeOutcomes,
  describePlan,
  metaOf,
  planRefresh,
  RATINGS_DIR,
  REFRESH_DEFAULTS,
  refreshRunDir,
  runRefresh,
} from "./leaderboard-refresh.js";
import { LEADERBOARD_FILE, readLeaderboard } from "./leaderboard.js";

const USAGE = `Usage:
  pnpm leaderboard add --rating <dir> --slug <slug> --name <name> --framework <name> [options]
  pnpm leaderboard refresh [options]

add: adds a rating (the folder arena rate wrote) to config/leaderboard.json at class level, and
with --post registers the agent on Robinhood Chain testnet and posts its score there.

  --kind <framework|reference>  a popular open-source template, or Bonded's own (default: framework)
  --template <url>     the published template the agent runs
  --model <id>         the model behind it (omit for a scripted agent)
  --disclosure <s>     not-needed, pending, notified or published (default: pending for a
                       framework, not-needed for a reference agent)
  --note <path>        its disclosure note in the repository
  --post               register and post the score (key: DEPLOYER_PRIVATE_KEY, or --attester-env)

refresh: re-rates every leaderboard entry with its agent and model and the standard settings
(${REFRESH_DEFAULTS.repeats} runs of each attack, the held-out set, ${REFRESH_DEFAULTS.episodeTimeoutS} s episodes, S1 on), then adds them all to
the file and posts them together. Safe to run again: complete ratings are skipped and only what
failed (a timeout, an agent error, a crash) is rated again. Ratings go in
apps/arena/ratings/refresh-v<library version>/<slug>.

  --dry-run            print the plan and cost estimate; run nothing
  --only <slug,...>    just these entries
  --max-usd <n>        total model spend cap for the run, counting earlier attempts (required
                       when a model-driven entry needs rating)
  --per-rating-max-usd <n>  one rating's cap (default: ${REFRESH_DEFAULTS.perRatingMaxUsd})
  --repeats <n>        runs of each attack (default: ${REFRESH_DEFAULTS.repeats})
  --episode-timeout <s>  each episode's limit (default: ${REFRESH_DEFAULTS.episodeTimeoutS})
  --held-out <dir>     the held-out attacks (default: the newest folder in ~/.config/bonded/held-out)
  --no-held-out        rate without a held-out set
  --attempts <n>       tries per entry in this run (default: ${REFRESH_DEFAULTS.attempts})
  --parallel <n>       ratings at once, each on its own local chain (default: ${REFRESH_DEFAULTS.parallel})
  --run <name>         the run folder under apps/arena/ratings (default: refresh-v<version>);
                       a new name re-rates everything on the same version
  --estimate-usd <n>   cost estimate per model-driven rating (default: ${REFRESH_DEFAULTS.estimateUsd})
  --no-post            update the leaderboard file only; don't post on chain
  --publish-partial    publish the complete entries even if some failed

Both:
  --attester-env <v>   .env variable holding the attester key (default: DEPLOYER_PRIVATE_KEY)
  --file <path>        the leaderboard file (default: config/leaderboard.json)`;

const fromCaller = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path);

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      rating: { type: "string" },
      slug: { type: "string" },
      name: { type: "string" },
      kind: { type: "string", default: "framework" },
      framework: { type: "string" },
      template: { type: "string" },
      model: { type: "string" },
      disclosure: { type: "string" },
      note: { type: "string" },
      post: { type: "boolean", default: false },
      "attester-env": { type: "string", default: "DEPLOYER_PRIVATE_KEY" },
      file: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      only: { type: "string" },
      "max-usd": { type: "string" },
      "per-rating-max-usd": { type: "string" },
      repeats: { type: "string" },
      "episode-timeout": { type: "string" },
      "held-out": { type: "string" },
      "no-held-out": { type: "boolean", default: false },
      attempts: { type: "string" },
      parallel: { type: "string" },
      run: { type: "string" },
      "estimate-usd": { type: "string" },
      "no-post": { type: "boolean", default: false },
      "publish-partial": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const file = values.file ? fromCaller(values.file) : LEADERBOARD_FILE;
  if (!values.help && positionals[0] === "refresh") return refresh(values, file);
  if (
    values.help ||
    positionals[0] !== "add" ||
    !values.rating ||
    !values.slug ||
    !values.name ||
    !values.framework
  ) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const kind = values.kind as LeaderboardEntry["kind"];
  const status = (values.disclosure ??
    (kind === "framework" ? "pending" : "not-needed")) as LeaderboardEntry["disclosure"]["status"];
  const { entry } = await addRating({
    ratingDir: fromCaller(values.rating),
    meta: {
      slug: values.slug,
      name: values.name,
      kind,
      framework: values.framework,
      model: values.model ?? null,
      disclosure: { status, ...(values.note ? { note: values.note } : {}) },
      ...(values.template ? { template: values.template } : {}),
    },
    file,
    post: values.post,
    attesterEnv: values["attester-env"],
    log: console.log,
  });
  console.log(`${entry.slug}: score ${entry.score} (${entry.tier}) -> ${file}`);
  return 0;
}

/** `pnpm leaderboard refresh` (see USAGE and docs/SCORING.md, "Refreshing the leaderboard"). */
async function refresh(
  values: {
    "dry-run": boolean;
    only?: string;
    "max-usd"?: string;
    "per-rating-max-usd"?: string;
    repeats?: string;
    "episode-timeout"?: string;
    "held-out"?: string;
    "no-held-out": boolean;
    attempts?: string;
    parallel?: string;
    run?: string;
    "estimate-usd"?: string;
    "no-post": boolean;
    "publish-partial": boolean;
    "attester-env": string;
  },
  file: string,
): Promise<number> {
  const heldOut = values["no-held-out"]
    ? null
    : values["held-out"]
      ? fromCaller(values["held-out"])
      : (defaultHeldOutDir() ?? null);
  if (heldOut === null && !values["no-held-out"])
    throw new Error(
      "no held-out set found in ~/.config/bonded/held-out: pass --held-out <dir>, or --no-held-out",
    );
  const settings = {
    repeats: count(values.repeats ?? String(REFRESH_DEFAULTS.repeats), "--repeats"),
    episodeTimeoutS: count(
      values["episode-timeout"] ?? String(REFRESH_DEFAULTS.episodeTimeoutS),
      "--episode-timeout",
    ),
    heldOut,
  };
  const maxUsd = values["max-usd"] === undefined ? undefined : usd(values["max-usd"], "--max-usd");
  const plan = planRefresh({
    entries: readLeaderboard(file),
    runDir: refreshRunDir(RATINGS_DIR, values.run),
    ...(values.only ? { only: values.only.split(",").map((s) => s.trim()) } : {}),
    ...(values["estimate-usd"]
      ? { estimateUsd: usd(values["estimate-usd"], "--estimate-usd") }
      : {}),
    repeats: settings.repeats,
  });
  for (const line of describePlan(plan, settings, maxUsd)) console.log(line);
  if (values["dry-run"]) return 0;
  console.log("");
  mkdirSync(plan.runDir, { recursive: true });
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const post = !values["no-post"];
  const result = await runRefresh(
    plan,
    {
      settings,
      ...(maxUsd === undefined ? {} : { maxUsd }),
      ...(values["per-rating-max-usd"]
        ? { perRatingMaxUsd: usd(values["per-rating-max-usd"], "--per-rating-max-usd") }
        : {}),
      ...(values.attempts ? { attempts: count(values.attempts, "--attempts") } : {}),
      ...(values.parallel ? { parallel: count(values.parallel, "--parallel") } : {}),
      publishPartial: values["publish-partial"],
    },
    {
      // Each rating is its own `arena rate` process (its own local chain), logged next to its folder.
      rate: (job, args, attempt) => {
        const log = `${job.dir}.log`;
        appendFileSync(
          log,
          `\n=== attempt ${attempt}, ${new Date().toISOString()}: arena ${args.join(" ")}\n`,
        );
        const fd = openSync(log, "a");
        return new Promise<number>((done, fail) => {
          const child = spawn(process.execPath, [cli, ...args], {
            cwd: dirname(dirname(cli)),
            stdio: ["ignore", fd, fd],
          });
          child.on("error", fail);
          child.on("exit", (code, signal) => {
            closeSync(fd);
            done(code ?? (signal ? 128 : 1));
          });
        });
      },
      add: (job) =>
        addRating({
          ratingDir: job.dir,
          meta: metaOf(job.entry),
          file,
          post,
          attesterEnv: values["attester-env"],
          log: (line) => console.log(`${job.entry.slug}: ${line}`),
        }),
      log: (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`),
    },
  );
  for (const line of describeOutcomes(result, {
    post,
    ...(maxUsd === undefined ? {} : { maxUsd }),
  }))
    console.log(line);
  const done =
    result.published &&
    result.outcomes.every((o) => (o.status === "rated" || o.status === "skipped") && !o.postError);
  return done ? 0 : 1;
}

function count(text: string, flag: string): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive whole number`);
  return n;
}

function usd(text: string, flag: string): number {
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive amount`);
  return n;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
