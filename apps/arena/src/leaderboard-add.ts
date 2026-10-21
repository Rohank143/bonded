import { type LeaderboardEntry } from "@bondedhq/shared";
import { crosspostEvm } from "./crosspost.js";
import { loadDotEnv } from "./env.js";
import {
  entryFromRating,
  loadRating,
  readLeaderboard,
  upsertEntry,
  writeLeaderboard,
} from "./leaderboard.js";

/** Who the entry is: everything but the results, which come from the rating. */
export type EntryMeta = Pick<
  LeaderboardEntry,
  "slug" | "name" | "kind" | "framework" | "model" | "disclosure"
> & { template?: string };

export interface AddRatingOptions {
  /** The folder `arena rate` wrote. */
  ratingDir: string;
  meta: EntryMeta;
  /** The leaderboard file. */
  file: string;
  /** Register the agent on Robinhood Chain testnet if needed and post its score. */
  post: boolean;
  /** The .env variable holding the attester (and owner) key. */
  attesterEnv: string;
  log?: (line: string) => void;
}

export interface AddRatingResult {
  entry: LeaderboardEntry;
  /** Set when this call posted the score; absent when it wasn't asked to or was already posted. */
  posted?: { agentId: string; status: string; tx: string };
}

/**
 * Adds a rating to the leaderboard file at class level (`pnpm leaderboard add`), and with `post`
 * registers the agent and posts its score. The folder is verified and checked publishable before
 * any side effect. Safe to repeat: a score already posted for the same report isn't posted again,
 * and a registered agent is saved at once, so a failed post resumes instead of registering twice.
 */
export async function addRating(options: AddRatingOptions): Promise<AddRatingResult> {
  const { meta, file } = options;
  const { report, attestation, reportHash } = loadRating(options.ratingDir);
  const entryWith = (onchain: LeaderboardEntry["onchain"]) =>
    entryFromRating(report, reportHash, { ...meta, onchain });
  const save = (entry: LeaderboardEntry) =>
    writeLeaderboard(upsertEntry(readLeaderboard(file), entry), file);
  const existing = readLeaderboard(file).find((e) => e.slug === meta.slug);
  // A posted score belongs to the rating it was posted for; a new rating starts unposted.
  const sameRating = existing?.reportHash === reportHash;
  let onchain: LeaderboardEntry["onchain"] = existing?.onchain
    ? { ...existing.onchain, tx: sameRating ? existing.onchain.tx : null }
    : null;
  let entry = entryWith(onchain);
  save(entry);
  if (!options.post || onchain?.tx) return { entry };
  loadDotEnv();
  const key = process.env[options.attesterEnv];
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new Error(`${options.attesterEnv} must hold a 0x private key (in .env)`);
  const result = await crosspostEvm({
    chain: "robinhoodTestnet",
    home: attestation,
    ...(onchain?.agentId ? { agentId: onchain.agentId } : {}),
    uri: `bonded://leaderboard/${meta.slug}`,
    attesterKey: key as `0x${string}`,
    ownerKey: key as `0x${string}`,
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
  options.log?.(`posted: agent ${result.agentId} ${result.status} ${result.tx}`);
  return { entry, posted: { agentId: result.agentId, status: result.status, tx: result.tx } };
}
