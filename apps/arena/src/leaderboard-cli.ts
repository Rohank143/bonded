#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type LeaderboardEntry } from "@bondedhq/shared";
import { crosspostEvm } from "./crosspost.js";
import { loadDotEnv } from "./env.js";
import {
  entryFromRating,
  LEADERBOARD_FILE,
  loadRating,
  readLeaderboard,
  upsertEntry,
  writeLeaderboard,
} from "./leaderboard.js";

const USAGE = `Usage: pnpm leaderboard add --rating <dir> --slug <slug> --name <name> --framework <name> [options]

Adds a rating (the folder arena rate wrote) to config/leaderboard.json at class level, and with
--post registers the agent on Robinhood Chain testnet and posts its score there.

  --kind <framework|reference>  a popular open-source template, or Bonded's own (default: framework)
  --template <url>     the published template the agent runs
  --model <id>         the model behind it (omit for a scripted agent)
  --disclosure <s>     not-needed, pending, notified or published (default: pending for a
                       framework, not-needed for a reference agent)
  --note <path>        its disclosure note in the repository
  --post               register and post the score (key: DEPLOYER_PRIVATE_KEY, or --attester-env)
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
      help: { type: "boolean", default: false },
    },
  });
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
  const file = values.file ? fromCaller(values.file) : LEADERBOARD_FILE;
  // Verified and publishable before any side effect (loadRating, entryFromRating).
  const { report, attestation, reportHash } = loadRating(fromCaller(values.rating));
  const status = (values.disclosure ??
    (kind === "framework" ? "pending" : "not-needed")) as LeaderboardEntry["disclosure"]["status"];
  const entryWith = (onchain: LeaderboardEntry["onchain"]) =>
    entryFromRating(report, reportHash, {
      slug: values.slug!,
      name: values.name!,
      kind,
      framework: values.framework!,
      model: values.model ?? null,
      onchain,
      disclosure: { status, ...(values.note ? { note: values.note } : {}) },
      ...(values.template ? { template: values.template } : {}),
    });
  const save = (entry: LeaderboardEntry) =>
    writeLeaderboard(upsertEntry(readLeaderboard(file), entry), file);
  const existing = readLeaderboard(file).find((e) => e.slug === values.slug);
  // A posted score belongs to the rating it was posted for; a new rating starts unposted.
  const sameRating = existing?.reportHash === reportHash;
  let onchain: LeaderboardEntry["onchain"] = existing?.onchain
    ? { ...existing.onchain, tx: sameRating ? existing.onchain.tx : null }
    : null;
  let entry = entryWith(onchain);
  save(entry);
  if (values.post && !onchain?.tx) {
    loadDotEnv();
    const key = process.env[values["attester-env"]];
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key))
      throw new Error(`${values["attester-env"]} must hold a 0x private key (in .env)`);
    const result = await crosspostEvm({
      chain: "robinhoodTestnet",
      home: attestation,
      ...(onchain?.agentId ? { agentId: onchain.agentId } : {}),
      uri: `bonded://leaderboard/${values.slug}`,
      attesterKey: key as `0x${string}`,
      ownerKey: key as `0x${string}`,
      // Save a new agent at once, so a failed score post resumes it instead of registering again.
      onRegistered: (agentId) => {
        onchain = { chain: "robinhoodTestnet", agentId, tx: null };
        save(entryWith(onchain));
      },
    });
    if (!result.tx)
      throw new Error(
        `agent ${result.agentId} already holds this score, but its post transaction isn't recorded here`,
      );
    onchain = { chain: "robinhoodTestnet", agentId: result.agentId, tx: result.tx };
    entry = entryWith(onchain);
    save(entry);
    console.log(`posted: agent ${result.agentId} ${result.status} ${result.tx}`);
  }
  console.log(`${entry.slug}: score ${entry.score} (${entry.tier}) -> ${file}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
