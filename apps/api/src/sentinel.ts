import type { Context, Hono } from "hono";
import { z } from "zod";
import { recoverMessageAddress, type Hex } from "viem";
import type { Database } from "@bonded/db";
import type { RatingSentinel } from "@bonded/arena";
import {
  GuardedAgent,
  LayaSentinel,
  SentinelGuard,
  createHardenedAgent,
  createPartialAgent,
  createVulnerableAgent,
  type SentinelModel,
} from "@bonded/demo-agents";
import {
  SENTINEL_CHECK_MAX_AGE_SECONDS,
  SENTINEL_INPUT_CHARS,
  SENTINEL_SERVING,
  mandateVaultAbi,
  mandateVaultFactoryAbi,
  sentinelCheckDigest,
  sentinelCheckMessage,
} from "@bonded/shared";
import type { ArenaAgent } from "@bonded/shared";
import type { ServiceChain } from "@bonded/keeper";
import { RateLimiter, clientAddress } from "./rate-limit.js";

/**
 * Sentinel in the product (docs/SENTINEL.md): the guard a rating runs with when an operator
 * opts in, and the check agents call before each trade. Its answers are advisory: they can
 * stop an action the agent was about to take, but payouts are decided by the vault alone.
 */
export interface SentinelService {
  model: SentinelModel;
  /** What a report records about this guard. */
  info: RatingSentinel;
}

/**
 * The production Sentinel from the environment: `SENTINEL_URL` (Railway's private network,
 * `http://sentinel.railway.internal:8000`) and `LAYA_API_KEY`, the bearer key the Sentinel
 * service checks. Undefined when it isn't configured, so the features that need it refuse
 * clearly instead of running without it.
 */
export function sentinelFromEnv(env: NodeJS.ProcessEnv = process.env): SentinelService | undefined {
  const url = env.SENTINEL_URL?.trim();
  if (!url) return undefined;
  return {
    model: new LayaSentinel({
      url: url.replace(/\/+$/, ""),
      apiKey: env.LAYA_API_KEY,
      questions: SENTINEL_SERVING.questions,
    }),
    info: {
      model: "laya/typed-decisions",
      questions: SENTINEL_SERVING.questions,
      blockThreshold: SENTINEL_SERVING.blockThreshold,
    },
  };
}

/** One of Bonded's built-in scripted designs, with Sentinel in front of it when given. */
export function ratedAgent(
  kind: "hardened" | "partial" | "vulnerable",
  sentinel?: SentinelService,
): ArenaAgent {
  const guards = sentinel ? [new SentinelGuard(sentinel.model, sentinel.info.blockThreshold)] : [];
  // The hardened design has its own guard chain; Sentinel joins it after the mandate check.
  if (kind === "hardened") return createHardenedAgent("scripted", {}, guards);
  const agent =
    kind === "partial" ? createPartialAgent("scripted") : createVulnerableAgent("scripted");
  return guards.length ? new GuardedAgent(agent, guards, "sentinel") : agent;
}

const uint = z
  .string()
  .regex(/^\d{1,78}$/)
  .transform((v) => BigInt(v).toString());
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const checkInput = z.strictObject({
  agentId: uint,
  vault: address,
  timestamp: z.number().int().positive(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  mandate: z.string().min(1).max(4_000),
  proposedAction: z.strictObject({
    tool: z.string().min(1).max(64),
    args: z
      .record(z.string().max(64), z.string().max(2_000))
      .refine((a) => Object.keys(a).length <= 20, "at most 20 arguments"),
  }),
  untrustedInputs: z
    .array(
      z.strictObject({
        tool: z.string().min(1).max(64),
        output: z.string().max(SENTINEL_INPUT_CHARS),
      }),
    )
    .max(20),
});

export interface SentinelLimits {
  /** Checks per client and in total, per window. */
  requests: ConstructorParameters<typeof RateLimiter>[0];
  /** Checks per agent per window (the agent is the client that matters). */
  perAgent: number;
  /** Checks running at once; Sentinel on CPU takes about 2.5 s each. */
  concurrent: number;
  /** Longest a check may take before the API gives up, in milliseconds. */
  timeoutMs: number;
  now?: () => number;
}

export const DEFAULT_SENTINEL_LIMITS: SentinelLimits = {
  requests: { perClient: 60, total: 600, windowMs: 60_000 },
  perAgent: 30,
  concurrent: 4,
  timeoutMs: 20_000,
};

class Refused extends Error {
  constructor(
    readonly status: 400 | 403 | 429 | 503,
    message: string,
  ) {
    super(message);
  }
}

/**
 * GET /sentinel: whether Sentinel is running here, its model and threshold, and checks in the
 * last day. GET /sentinel/agents/:id: one agent's checks in the last 7 days.
 * POST /sentinel/check: an agent asks about one proposed action, signed with its own key.
 */
export function sentinelRoutes(
  app: Hono,
  options: {
    db: Database;
    chain: ServiceChain;
    sentinel?: SentinelService;
    limits?: Partial<SentinelLimits>;
  },
) {
  const { db, chain, sentinel } = options;
  const d = chain.deployment;
  const limits = { ...DEFAULT_SENTINEL_LIMITS, ...options.limits };
  const now = () => (limits.now ?? Date.now)();
  const requests = new RateLimiter({ ...limits.requests, now });
  const agents = new RateLimiter({
    perClient: limits.perAgent,
    total: Number.MAX_SAFE_INTEGER,
    windowMs: limits.requests.windowMs,
    now,
  });
  let running = 0;

  // A vault's agent key changes only by redeploying, so each lookup is kept for a minute.
  const keys = new Map<string, { at: number; agent: string | undefined }>();
  async function agentKey(vault: Hex, agentId: string): Promise<string | undefined> {
    const key = `${vault.toLowerCase()}:${agentId}`;
    const hit = keys.get(key);
    if (hit && now() - hit.at < 60_000) return hit.agent;
    const isVault = await chain.read.readContract({
      address: d.factory,
      abi: mandateVaultFactoryAbi,
      functionName: "isVault",
      args: [vault],
    });
    let agent: string | undefined;
    if (isVault) {
      const [owner, signer] = await Promise.all([
        chain.read.readContract({ address: vault, abi: mandateVaultAbi, functionName: "agentId" }),
        chain.read.readContract({ address: vault, abi: mandateVaultAbi, functionName: "agent" }),
      ]);
      if (owner.toString() === agentId) agent = signer.toLowerCase();
    }
    if (keys.size > 5_000) keys.clear();
    keys.set(key, { at: now(), agent });
    return agent;
  }

  const handle = (fn: (c: Context) => Promise<Response>) => async (c: Context) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof Refused) return c.json({ error: e.message }, e.status);
      throw e;
    }
  };

  app.get("/sentinel", async (c) => {
    const day = await db.sentinelCheckCounts(d.chainId, new Date(now() - 86_400_000));
    return c.json({
      available: Boolean(sentinel),
      ...(sentinel ? sentinel.info : {}),
      last24h: { checks: day.checks, blocked: day.blocked },
    });
  });

  app.get("/sentinel/agents/:id", async (c) => {
    const agentId = uint.parse(c.req.param("id"));
    const week = await db.sentinelCheckCounts(d.chainId, new Date(now() - 7 * 86_400_000), agentId);
    return c.json({
      last7d: { checks: week.checks, blocked: week.blocked },
      lastCheckAt: week.lastAt ? week.lastAt.toISOString() : null,
    });
  });

  app.post(
    "/sentinel/check",
    handle(async (c) => {
      if (!sentinel) throw new Refused(503, "Sentinel isn't running on this API");
      if (!requests.allow(clientAddress(c.req.raw.headers)))
        throw new Refused(429, "too many checks; slow down");
      const input = checkInput.parse(await c.req.json());
      const age = Math.floor(now() / 1000) - input.timestamp;
      if (age > SENTINEL_CHECK_MAX_AGE_SECONDS || age < -60)
        throw new Refused(400, "the signed check has expired; sign it again");
      const body = {
        mandate: input.mandate,
        proposedAction: input.proposedAction,
        untrustedInputs: input.untrustedInputs,
      };
      const signer = await recoverMessageAddress({
        message: sentinelCheckMessage({
          chainId: d.chainId,
          agentId: input.agentId,
          vault: input.vault,
          digest: sentinelCheckDigest(body),
          timestamp: input.timestamp,
        }),
        signature: input.signature as Hex,
      }).catch(() => undefined);
      if (!signer) throw new Refused(400, "the signature is not valid");
      const expected = await agentKey(input.vault as Hex, input.agentId);
      if (!expected) throw new Refused(400, "that vault doesn't belong to this agent");
      if (signer.toLowerCase() !== expected)
        throw new Refused(403, "sign with the vault's agent key");
      if (!agents.allow(input.agentId)) throw new Refused(429, "too many checks for this agent");
      if (running >= limits.concurrent)
        throw new Refused(503, "Sentinel is busy; try again in a few seconds");
      running++;
      try {
        const assessment = await sentinel.model.assess(body, {
          signal: AbortSignal.timeout(limits.timeoutMs),
        });
        const blocked = assessment.manipulated >= sentinel.info.blockThreshold;
        await db.recordSentinelCheck(d.chainId, input.agentId, {
          manipulated: assessment.manipulated,
          blocked,
          latencyMs: assessment.latencyMs,
        });
        return c.json({
          blocked,
          manipulated: assessment.manipulated,
          injection: assessment.injection,
          blockThreshold: sentinel.info.blockThreshold,
          model: assessment.model,
          latencyMs: Math.round(assessment.latencyMs),
          // Advisory: the agent decides whether to go ahead; the vault still enforces the mandate.
          advice: blocked
            ? "Don't take this action: it looks driven by what the agent read, not its mandate."
            : "No sign of manipulation.",
        });
      } catch (e) {
        if (e instanceof Refused) throw e;
        if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"))
          throw new Refused(503, "Sentinel took too long; try again");
        throw e;
      } finally {
        running--;
      }
    }),
  );
}
