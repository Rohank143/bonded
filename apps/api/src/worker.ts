import { Database, json } from "@bonded/db";
import {
  Sandbox,
  rateAgent,
  attestTeeAgent,
  publicEpisode,
  signAttestation,
  type SignedAttestation,
} from "@bonded/arena";
import {
  EvmMandate,
  mandateHash,
  attestationMessage,
  bondedRegistryAbi,
  type EvmMandateInput,
} from "@bonded/shared";
import { z } from "zod";
import { getAbiItem, hashTypedData, type Hex } from "viem";
import { attestationTypedData, bondedDomain } from "@bonded/shared";
import type { ServiceChain } from "@bonded/keeper";
import { ratingLibrary } from "./library.js";
import { ratedAgent, type SentinelService } from "./sentinel.js";

// Operators provision these records; callers cannot choose RPCs, code, commands or model URLs.
export const agentConfig = z.strictObject({
  kind: z.enum(["hardened", "vulnerable", "partial"]),
  mandate: EvmMandate,
  codeHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  /**
   * Where the agent runs in a TEE: its https URL and the compose hash published for this
   * `codeHash`'s deployment. When set, the rating fails unless the agent proves it (ADR-012).
   */
  tee: z
    .strictObject({
      url: z.url({ protocol: /^https$/ }),
      composeHash: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/),
    })
    .optional(),
  /**
   * Runs of each attack seed in a rating (default 1, at most 10). More runs tighten the 90% upper
   * bound on each breach rate, so a robust agent scores closer to what it deserves. The plan's
   * worked examples use 5. The report lists the episode count, so the number is visible.
   */
  repeats: z.number().int().min(1).max(10).optional(),
  /**
   * Rate the agent with Sentinel in front of it (docs/SENTINEL.md). The report records it, and
   * the rating fails if Sentinel isn't configured: it never quietly rates without it.
   */
  sentinel: z.boolean().optional(),
});
/** Process one durable rating job under the chain worker lock; retries recover accepted posts. */
export async function workOne(
  db: Database,
  chain: ServiceChain,
  rpcUrl: string,
  key: Hex,
  onError?: (error: unknown) => void,
  sentinel?: SentinelService,
) {
  const lock = await db.pool.connect();
  const locked = (
    await lock.query("SELECT pg_try_advisory_lock(7004,$1) AS locked", [chain.deployment.chainId])
  ).rows[0].locked;
  if (!locked) {
    lock.release();
    return false;
  }
  try {
    return await runLocked(db, chain, rpcUrl, key, onError, sentinel);
  } finally {
    await lock.query("SELECT pg_advisory_unlock(7004,$1)", [chain.deployment.chainId]);
    lock.release();
  }
}
/** Run a leased rating, persist report bytes, and post its attestation while ownership holds. */
async function runLocked(
  db: Database,
  chain: ServiceChain,
  rpcUrl: string,
  key: Hex,
  onError?: (error: unknown) => void,
  sentinel?: SentinelService,
) {
  const job = await db.takeJob(chain.deployment.chainId);
  if (!job) return false;
  let leaseError: unknown;
  const heartbeat = setInterval(() => {
    void db.renew(job).catch((e) => {
      leaseError = e;
    });
  }, 15000);
  const check = async () => {
    if (leaseError) throw leaseError;
    await db.renew(job);
  };
  try {
    const row = (
      await db.pool.query(
        "SELECT r.*,a.config,a.agent_id AS onchain_id FROM ratings r JOIN agents a ON a.id=r.agent_id WHERE r.id=$1",
        [job.id],
      )
    ).rows[0];
    const config = agentConfig.parse(row.config);
    if (
      config.mandate.chain.chainId !== chain.deployment.chainId ||
      config.mandate.agentId !== row.onchain_id
    )
      throw new Error("agent config identity mismatch");
    if (config.sentinel && !sentinel)
      throw new Error("this agent is rated with Sentinel on, but SENTINEL_URL isn't set");
    await db.withLease(job, (c) =>
      c.query("UPDATE ratings SET status='running' WHERE id=$1", [job.id]),
    );
    let signed = row.attestation as SignedAttestation | null;
    if (!signed) {
      // A TEE that doesn't verify fails the job. It never falls back to an unmeasured rating.
      const tee = config.tee
        ? await attestTeeAgent({
            url: config.tee.url,
            codeHash: config.codeHash as Hex,
            composeHash: config.tee.composeHash,
          })
        : undefined;
      await check();
      // The published seeds, accepted bounties and the active held-out set (library.ts).
      const library = await ratingLibrary(db, chain.deployment.chainId);
      const publishedAs = (attackId: string | null) => {
        const spec = attackId ? library.attacks.find((a) => a.id === attackId) : undefined;
        return spec && !library.unpublished.has(spec.id)
          ? { published: true, title: spec.title }
          : { published: false };
      };
      const sandbox = await Sandbox.start({ forkUrl: rpcUrl, forkDeployment: chain.deployment });
      try {
        const result = await rateAgent(sandbox, {
          agent: ratedAgent(config.kind, config.sentinel ? sentinel : undefined),
          ...(config.sentinel && sentinel ? { sentinel: sentinel.info } : {}),
          attacks: library.attacks,
          unpublished: library.unpublished,
          codeHash: config.codeHash as Hex,
          ...(config.repeats ? { repeats: config.repeats } : {}),
          ...(tee ? { tee } : {}),
          vault: { mandate: config.mandate as EvmMandateInput },
          onEpisode: async (episode, index, total) => {
            await check();
            // Verdict only: planted text and traces can carry a private bounty payload.
            await db.publish("rating.episode", {
              runId: job.id,
              index,
              total,
              // A library attack's text is public in attacks/; held-out and bounty text never is.
              episode: publicEpisode(episode, publishedAs(episode.attackId)),
            });
          },
        });
        if (result.report.stoppedEarly || result.report.episodes.agentErrors)
          throw new Error("incomplete rating");
        const current = await chain.read.readContract({
          address: chain.deployment.registry,
          abi: bondedRegistryAbi,
          functionName: "scoreOf",
          args: [BigInt(row.onchain_id)],
        });
        // Registry versions are strictly increasing, including two ratings in one block.
        const now = Math.max(
          Number((await chain.read.getBlock()).timestamp),
          Number(current.issuedAt) + 1,
        );
        signed = await signAttestation(
          {
            ...result.attestation.attestation,
            agentId: row.onchain_id,
            mandateHash: mandateHash(config.mandate),
            issuedAt: now,
            expiresAt: now + 30 * 86400,
          },
          {
            chainId: chain.deployment.chainId,
            registry: chain.deployment.registry,
            attesterKey: key,
          },
        );
        await check();
        await db.withLease(job, (c) =>
          c.query("UPDATE ratings SET report=$2,attestation=$3,report_json=$4 WHERE id=$1", [
            job.id,
            json(result.report),
            json(signed),
            `${JSON.stringify(result.report, null, 2)}\n`,
          ]),
        );
      } finally {
        await sandbox.stop();
      }
    }
    await check();
    // A retried post is safe: recover its receipt via ScorePosted logs if already accepted.
    const previous = await db.pool.query("SELECT 1 FROM attestations WHERE id=$1", [job.id]);
    if (!previous.rowCount) {
      const digest = hashTypedData(
        attestationTypedData(
          bondedDomain(chain.deployment.chainId, chain.deployment.registry),
          signed.attestation,
        ),
      );
      const logs = await chain.read.getLogs({
        address: chain.deployment.registry,
        event: getAbiItem({ abi: bondedRegistryAbi, name: "ValidationResponse" }),
        args: { requestHash: digest },
        fromBlock: BigInt(chain.deployment.deployedAtBlock),
        toBlock: "latest",
        strict: true,
      });
      const hash =
        logs[0]?.transactionHash ??
        (await chain.send(chain.deployment.registry, bondedRegistryAbi, "postScore", [
          attestationMessage(signed.attestation),
          signed.signature,
        ]));
      await check();
      const reportTee = (
        await db.pool.query("SELECT report->'tee' AS tee FROM ratings WHERE id=$1", [job.id])
      ).rows[0]?.tee as { evmAddress?: string } | null;
      await db.withLease(job, async (c) => {
        await c.query(
          "INSERT INTO attestations(id,agent_id,signed,tx_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [job.id, row.agent_id, json(signed), hash],
        );
        // The posted score replaces whatever an earlier TEE failure was about (ADR-013): record its
        // key and measurement, or drop the TEE row if this rating has no TEE.
        const agentKey = `${chain.deployment.chainId}:${row.onchain_id}`;
        if (reportTee?.evmAddress)
          await db.recordTeeRating(
            {
              agentId: agentKey,
              ratedMeasurement: signed.attestation.teeMeasurement,
              ratedReportHash: signed.attestation.reportHash,
              evmAddress: reportTee.evmAddress,
            },
            c,
          );
        else await db.recordTeeRating({ agentId: agentKey }, c);
      });
    }
    await db.finish(job);
  } catch (error) {
    onError?.(error);
    await db.finish(job, "rating failed; retry scheduled");
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
