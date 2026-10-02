import {
  attestTeeAgent,
  TeeUnavailableError,
  TeeVerificationError,
  type VerifiedTee,
} from "@bonded/arena";
import type { Database } from "@bonded/db";
import type { ServiceChain } from "@bonded/keeper";
import { bondedRegistryAbi, isTeeMeasurement } from "@bonded/shared";
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
}

export type Attest = (options: {
  url: string;
  codeHash: `0x${string}`;
  composeHash: string;
}) => Promise<VerifiedTee>;

/** Checks one agent's live TEE against the measurement in its current score. */
export async function checkAgentTee(
  tee: { url: string; composeHash: string },
  codeHash: `0x${string}`,
  rated: string,
  attest: Attest = attestTeeAgent,
): Promise<TeeCheckResult> {
  try {
    const live = await attest({ url: tee.url, codeHash, composeHash: tee.composeHash });
    if (!isTeeMeasurement(rated)) return { status: "unrated", measurement: live.measurement };
    if (live.measurement.toLowerCase() !== rated.toLowerCase())
      return {
        status: "mismatch",
        detail: "the running measurement is not the one that was rated",
        measurement: live.measurement,
      };
    return { status: "verified", measurement: live.measurement };
  } catch (error) {
    if (error instanceof TeeUnavailableError)
      return { status: "unreachable", detail: error.message };
    if (error instanceof TeeVerificationError) return { status: "invalid", detail: error.message };
    return { status: "unreachable", detail: "the check could not run" };
  }
}

/** Checks every enabled agent on this chain that has a TEE configured, and stores the results. */
export async function runTeeChecks(
  db: Database,
  chain: ServiceChain,
  attest: Attest = attestTeeAgent,
): Promise<number> {
  const rows = await db.pool.query(
    "SELECT agent_id,config FROM agents WHERE chain_id=$1 AND enabled",
    [chain.deployment.chainId],
  );
  let checked = 0;
  for (const row of rows.rows) {
    const config = agentConfig.safeParse(row.config);
    if (!config.success || !config.data.tee) continue;
    const score = await chain.read.readContract({
      address: chain.deployment.registry,
      abi: bondedRegistryAbi,
      functionName: "scoreOf",
      args: [BigInt(row.agent_id)],
    });
    const result = await checkAgentTee(
      config.data.tee,
      config.data.codeHash as `0x${string}`,
      score.teeMeasurement,
      attest,
    );
    await db.recordTeeCheck({
      agentId: `${chain.deployment.chainId}:${row.agent_id}`,
      ...result,
    });
    checked++;
  }
  return checked;
}

export const teeCheckInterval = z.coerce.number().int().min(60_000);
