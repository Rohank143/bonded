import {
  attestTeeAgent,
  TeeUnavailableError,
  TeeVerificationError,
  type VerifiedTee,
} from "@bonded/arena";
import type { Database, RemoteQuota, TeeCheckRow } from "@bonded/db";
import type { ServiceChain } from "@bonded/keeper";
import { bondedRegistryAbi, isTeeMeasurement } from "@bondedhq/shared";
import { z } from "zod";
import { agentConfig } from "./worker.js";

/**
 * The keeper's live re-check of TEE-hosted agents (ADR-013). The rating proved a deployment once;
 * this keeps checking that the same deployment is still what answers.
 *
 * - `verified`: a fresh quote verifies and its measurement is the one in the agent's current score.
 * - `unrated`: the quote verifies, but the current score carries no measurement (no TEE rating yet).
 * - `mismatch`: the quote verifies, but it is not the measurement that was rated.
 * - `invalid`: the evidence fails verification (bad quote, wrong code, wrong compose hash, wrong keys).
 * - `unreachable`: no answer, or Intel's data couldn't be fetched. Says nothing about the agent.
 */
export type TeeStatus = "verified" | "unrated" | "mismatch" | "invalid" | "unreachable";

/**
 * Statuses that stop new quotes. Only a definite failure does: an unreachable agent can't leak a
 * key (the key never leaves the VM), so a stopped VM must not lock an agent out of cover.
 */
export const QUOTE_BLOCKING: readonly string[] = ["mismatch", "invalid"];

export interface TeeCheckResult {
  status: TeeStatus;
  detail?: string;
  measurement?: string;
  /** The live agent's EVM key, set when the evidence verified. */
  evmAddress?: string;
}

export type Attest = (options: {
  url: string;
  codeHash: `0x${string}`;
  composeHash: string;
}) => Promise<VerifiedTee>;

/**
 * Checks one agent's live TEE against the measurement in its current score and, when known, the key
 * recorded for that rating. Only failing to get evidence is `unreachable`. Anything else that goes
 * wrong with evidence is a failure: a hostile agent must not be able to make itself "unreachable".
 */
export async function checkAgentTee(
  tee: { url: string; composeHash: string },
  codeHash: `0x${string}`,
  rated: string,
  attest: Attest = attestTeeAgent,
  ratedEvm?: string | null,
): Promise<TeeCheckResult> {
  try {
    const live = await attest({ url: tee.url, codeHash, composeHash: tee.composeHash });
    if (!isTeeMeasurement(rated))
      return { status: "unrated", measurement: live.measurement, evmAddress: live.evmAddress };
    if (live.measurement.toLowerCase() !== rated.toLowerCase())
      return {
        status: "mismatch",
        detail: "the running measurement is not the one that was rated",
        measurement: live.measurement,
      };
    if (ratedEvm && live.evmAddress.toLowerCase() !== ratedEvm.toLowerCase())
      return {
        status: "mismatch",
        detail: "the TEE agent's key is not the key recorded for this rating",
        measurement: live.measurement,
      };
    return { status: "verified", measurement: live.measurement, evmAddress: live.evmAddress };
  } catch (error) {
    if (error instanceof TeeUnavailableError)
      return { status: "unreachable", detail: error.message };
    if (error instanceof TeeVerificationError) return { status: "invalid", detail: error.message };
    return { status: "invalid", detail: "the check failed unexpectedly" };
  }
}

/**
 * Why new cover can't be quoted for this vault, or undefined when it can. Applies only to an agent
 * whose current score carries a TEE measurement (the discount in ADR-014). It requires that:
 *
 * - the TEE's key is on record for this very score (the rating, or a verified check, recorded it);
 * - the vault's execution key IS that key, otherwise the vault is not protected by the TEE and
 *   the discount would be unearned (this also catches a later key rotation);
 * - no definite failure (`mismatch`, `invalid`) is outstanding for this score. An `unreachable`
 *   agent does not block, and neither does a failure recorded against an older score.
 */
export function teeQuoteBlock(input: {
  onchainMeasurement: string;
  onchainReportHash: string;
  vaultAgent: string;
  row?: TeeCheckRow | undefined;
}): string | undefined {
  const { onchainMeasurement: rated, onchainReportHash, vaultAgent, row } = input;
  if (!isTeeMeasurement(rated)) return undefined;
  if (
    !row?.evmAddress ||
    row.ratedMeasurement?.toLowerCase() !== rated.toLowerCase() ||
    row.ratedReportHash?.toLowerCase() !== onchainReportHash.toLowerCase()
  )
    return "the TEE agent's key is not on record for this rating yet; re-rate the agent";
  if (row.evmAddress.toLowerCase() !== vaultAgent.toLowerCase())
    return "the vault's execution key is not the TEE agent's attested key";
  if (row.blockingStatus && QUOTE_BLOCKING.includes(row.blockingStatus))
    return "the agent's TEE no longer matches its rating; re-rate it first";
  return undefined;
}

/**
 * Checks every enabled agent on this chain that has a TEE configured, Bonded's own or an operator's
 * (bring your own agent), and stores the results. When an operator's agent no longer runs what was
 * rated (`mismatch`), quotes stop (`teeQuoteBlock`) and a re-rating is queued if its runner is
 * connected, at most once per `rerateGapMs`; with no runner the skip is recorded with its reason.
 */
export async function runTeeChecks(
  db: Database,
  chain: ServiceChain,
  attest: Attest = attestTeeAgent,
  options: { rerateGapMs?: number; quota?: RemoteQuota } = {},
): Promise<number> {
  const rows = await db.pool.query(
    "SELECT agent_id,config FROM agents WHERE chain_id=$1 AND enabled",
    [chain.deployment.chainId],
  );
  let checked = 0;
  for (const row of rows.rows) {
    const key = `${chain.deployment.chainId}:${row.agent_id}`;
    const config = agentConfig.safeParse(row.config);
    if (!config.success || !config.data.tee) {
      // No TEE configured (any more): an old failure must not outlive the configuration.
      await db.clearTee(key);
      continue;
    }
    // Read the row first: a worker may replace it while the chain read or attestation is pending.
    const previous = await db.teeCheck(key);
    const observedReportHash = previous?.ratedReportHash ?? null;
    let score;
    try {
      score = await chain.read.readContract({
        address: chain.deployment.registry,
        abi: bondedRegistryAbi,
        functionName: "scoreOf",
        args: [BigInt(row.agent_id)],
      });
    } catch {
      await db.recordTeeCheck({
        agentId: key,
        status: "unreachable",
        detail: "the on-chain score could not be read",
        ratedMeasurement: previous?.ratedMeasurement ?? undefined,
        ratedReportHash: previous?.ratedReportHash ?? undefined,
        observedReportHash,
      });
      checked++;
      continue;
    }
    const ratedEvm =
      previous?.ratedReportHash?.toLowerCase() === score.reportHash.toLowerCase() &&
      previous.ratedMeasurement?.toLowerCase() === score.teeMeasurement.toLowerCase()
        ? previous.evmAddress
        : null;
    const result = await checkAgentTee(
      config.data.tee,
      config.data.codeHash as `0x${string}`,
      score.teeMeasurement,
      attest,
      ratedEvm,
    );
    await db.recordTeeCheck({
      agentId: key,
      ratedMeasurement: score.teeMeasurement,
      ratedReportHash: score.reportHash,
      observedReportHash,
      ...result,
    });
    if (result.status === "mismatch" && config.data.kind === "remote")
      await rerateChanged(db, key, options.rerateGapMs ?? 60 * 60_000, options.quota);
    checked++;
  }
  return checked;
}

/** A remote agent's TEE changed: re-rate it through its runner, or record why it can't be. */
async function rerateChanged(db: Database, key: string, gapMs: number, quota?: RemoteQuota) {
  if (await db.runnerIsConnected(key)) await db.enqueueIfIdle(key, gapMs, quota);
  else
    await db.recordRatingSkip(
      key,
      "tee-changed",
      "the agent's TEE no longer runs what was rated, and its runner is offline; connect it and rate the agent",
    );
}

export const teeCheckInterval = z.coerce.number().int().min(60_000);
