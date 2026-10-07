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
  REMOTE_MODES,
  mandateHash,
  attestationMessage,
  bondedRegistryAbi,
  type ArenaAgent,
  type EvmMandateInput,
} from "@bonded/shared";
import { z } from "zod";
import { getAbiItem, hashTypedData, type Hex } from "viem";
import { attestationTypedData, bondedDomain } from "@bonded/shared";
import type { ServiceChain } from "@bonded/keeper";
import { ratingLibrary } from "./library.js";
import { ratedAgent, sentinelCodeHash, type SentinelService } from "./sentinel.js";
import {
  RatingRefused,
  TeeBinding,
  remoteAgentFor,
  type RemoteAgentFactory,
} from "./remote-agent.js";

const codeHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
/**
 * Where the agent runs in a TEE: its https URL and the compose hash published for this
 * `codeHash`'s deployment. When set, the rating fails unless the agent proves it (ADR-012).
 */
export const teeConfig = z.strictObject({
  url: z.url({ protocol: /^https$/ }),
  composeHash: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/),
});
/**
 * Runs of each attack seed in a rating (default 1, at most 10). More runs tighten the 90% upper
 * bound on each breach rate, so a robust agent scores closer to what it deserves. The plan's
 * worked examples use 5. The report lists the episode count, so the number is visible.
 */
const repeats = z.number().int().min(1).max(10).optional();

/** One of Bonded's built-in designs, run in the Arena itself. */
const builtInConfig = z
  .strictObject({
    kind: z.enum(["hardened", "vulnerable", "partial"]),
    mandate: EvmMandate,
    codeHash,
    tee: teeConfig.optional(),
    repeats,
    /**
     * Rate the agent with Sentinel in front of it (docs/SENTINEL.md). The report records it, and
     * the rating fails if Sentinel isn't configured: it never quietly rates without it.
     */
    sentinel: z.boolean().optional(),
  })
  // A TEE proves the agent's own code hash; a rating with Sentinel in front attests a combined
  // one, so the two can't be checked against each other yet.
  .refine((c) => !(c.sentinel && c.tee), {
    message: "a Sentinel-on rating of a TEE agent isn't supported yet",
    path: ["sentinel"],
  });

/**
 * The operator's own agent (bring your own agent, docs/BRING-YOUR-OWN-AGENT.md): it runs on the
 * operator's servers and is rated through the Arena Gateway by its runner. `codeHash` is what the
 * operator declares; with `tee`, every episode must prove it with TEE evidence.
 */
const remoteConfig = z.strictObject({
  kind: z.literal("remote"),
  mandate: EvmMandate,
  codeHash,
  mode: z.enum(REMOTE_MODES),
  tee: teeConfig.optional(),
  repeats,
});

// Operators provision these records, or owners register them signed (self-serve.ts); callers
// cannot choose RPCs, commands or model URLs. A remote agent's code runs on its operator's side.
export const agentConfig = z.union([builtInConfig, remoteConfig]);
export type AgentConfig = z.infer<typeof agentConfig>;

/** Options for the rating worker beyond its chain and key. */
export interface WorkerOptions {
  /**
   * Builds the remote agent for a bring-your-own agent's rating (the Arena Gateway's
   * `RemoteAgent`). Without it such ratings fail at once with "gateway not available".
   */
  remote?: RemoteAgentFactory;
}

/**
 * The code hash a rating attests. `codeHash` is always the agent's own code; with Sentinel in
 * front the rated code is different, so it gets the combined hash (`sentinelCodeHash`). This
 * holds for operator configs and self-serve registrations alike.
 */
export function ratedCodeHash(config: { codeHash: string; sentinel?: boolean }): Hex {
  return config.sentinel ? sentinelCodeHash(config.codeHash as Hex) : (config.codeHash as Hex);
}
/** Process one durable rating job under the chain worker lock; retries recover accepted posts. */
export async function workOne(
  db: Database,
  chain: ServiceChain,
  rpcUrl: string,
  key: Hex,
  onError?: (error: unknown) => void,
  sentinel?: SentinelService,
  options: WorkerOptions = {},
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
    return await runLocked(db, chain, rpcUrl, key, onError, sentinel, options);
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
  options: WorkerOptions = {},
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
    const withSentinel = config.kind !== "remote" && config.sentinel === true;
    if (withSentinel && !sentinel)
      throw new Error("this agent is rated with Sentinel on, but SENTINEL_URL isn't set");
    // A remote agent is rated through its runner: with none connected, the rating can't start.
    // It is retried, in case the runner is only reconnecting.
    if (config.kind === "remote" && !(await db.runnerIsConnected(row.agent_id)))
      throw new RatingRefused(
        "the agent's runner is not connected; start it and rate again",
        false,
      );
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
      // A rating restarted after a crash or a lost lease runs again from the first episode. The
      // episodes an abandoned attempt published would stay in the Arena twice over, so they go.
      await db.withLease(job, (c) => db.clearRunEpisodes(job.id, c));
      // The published seeds, accepted bounties and the active held-out set (library.ts).
      const library = await ratingLibrary(db, chain.deployment.chainId);
      const publishedAs = (attackId: string | null) => {
        const spec = attackId ? library.attacks.find((a) => a.id === attackId) : undefined;
        return spec && !library.unpublished.has(spec.id)
          ? { published: true, title: spec.title }
          : { published: false };
      };
      // A remote agent's TEE must prove itself again at every episode, as the same deployment.
      const binding =
        config.kind === "remote" && tee && config.tee
          ? new TeeBinding(tee, {
              codeHash: config.codeHash as Hex,
              composeHash: config.tee.composeHash,
            })
          : undefined;
      const agent: ArenaAgent =
        config.kind === "remote"
          ? remoteAgentFor(options.remote, {
              agentKey: row.agent_id,
              chainId: chain.deployment.chainId,
              agentId: String(row.onchain_id),
              mode: config.mode,
              codeHash: config.codeHash as Hex,
              ...(binding && tee
                ? {
                    tee: {
                      evmAddress: tee.evmAddress,
                      verify: (evidence: unknown, nonce: Hex) => binding.check(evidence, nonce),
                    },
                  }
                : {}),
            })
          : ratedAgent(config.kind, withSentinel ? sentinel : undefined);
      const sandbox = await Sandbox.start({ forkUrl: rpcUrl, forkDeployment: chain.deployment });
      try {
        const result = await rateAgent(sandbox, {
          agent,
          ...(withSentinel && sentinel ? { sentinel: sentinel.info } : {}),
          attacks: library.attacks,
          unpublished: library.unpublished,
          codeHash: ratedCodeHash(config),
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
        // Every episode must have shown the same TEE deployment, or the measurement isn't earned.
        // Checked first: a failed TEE check also ends its episode, and this says why.
        const unbound = binding?.verdict(result.report.episodes.total);
        if (unbound) throw new RatingRefused(unbound, false);
        if (result.report.stoppedEarly || result.report.episodes.agentErrors)
          throw new Error("incomplete rating");
        // A guard that couldn't answer refused the write to stay safe, but that's no evidence the
        // guard works: never attest a score that leaned on it.
        if (result.report.guardFailures)
          throw new Error(
            `incomplete rating: a guard failed to answer ${result.report.guardFailures} times`,
          );
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
    // A refusal's reason is safe to show the owner; anything else may carry an RPC URL or a key.
    if (error instanceof RatingRefused) await db.finish(job, error.message, { final: error.final });
    else await db.finish(job, "rating failed; retry scheduled");
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
