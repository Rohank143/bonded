#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type LeaderboardEntry } from "@bonded/shared";
import { crosspostEvm } from "./crosspost.js";
import { loadDotEnv } from "./env.js";
import {
  entryFromRating,
  LEADERBOARD_FILE,
  ratingAttestation,
  readLeaderboard,
  upsertEntry,
  writeLeaderboard,
} from "./leaderboard.js";
import type { RatingReport } from "./rate.js";

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
  const dir = fromCaller(values.rating);
  const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as RatingReport;
  const { attestation, reportHash } = ratingAttestation(join(dir, "attestation.json"));
  const entries = readLeaderboard(file);
  const existing = entries.find((e) => e.slug === values.slug);
  let onchain = existing?.onchain ?? null;
  if (values.post) {
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
    });
    if (!result.tx && !onchain)
      throw new Error("the registry already had this score but no transaction is recorded");
    onchain = {
      chain: "robinhoodTestnet",
      agentId: result.agentId,
      tx: (result.tx ?? onchain!.tx) as string,
    };
    console.log(
      `posted: agent ${result.agentId} ${result.status}${result.tx ? ` ${result.tx}` : ""}`,
    );
  }
  const entry = entryFromRating(report, reportHash, {
    slug: values.slug,
    name: values.name,
    kind,
    framework: values.framework,
    model: values.model ?? null,
    onchain,
    disclosure: {
      status: (values.disclosure ??
        (kind === "framework"
          ? "pending"
          : "not-needed")) as LeaderboardEntry["disclosure"]["status"],
      ...(values.note ? { note: values.note } : {}),
    },
    ...(values.template ? { template: values.template } : {}),
  });
  writeLeaderboard(upsertEntry(entries, entry), file);
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
