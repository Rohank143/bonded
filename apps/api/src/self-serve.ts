import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Database } from "@bonded/db";
import {
  bondedRegistryAbi,
  EvmMandate,
  mandateHash,
  mandateVaultAbi,
  mandateVaultFactoryAbi,
  REMOTE_KIND,
  REMOTE_MODES,
  SELF_SERVE_KINDS,
  SELF_SERVE_MAX_AGE_SECONDS,
  UNDERWRITING_COVER_CAP_USD,
  selfServeMessage,
  toEvmMandateParams,
  type EvmMandate as EvmMandateType,
  type AgentMode,
  type BindingLevel,
  type SelfServeKind,
  type SelfServeRequest,
} from "@bonded/shared";
import type { ServiceChain } from "@bonded/keeper";
import {
  decodeFunctionData,
  getAbiItem,
  keccak256,
  recoverMessageAddress,
  stringToBytes,
  type Hex,
} from "viem";
import { RateLimiter, clientAddress } from "./rate-limit.js";
import { helloProblem, newRunnerToken, runnerTokenHash } from "./runners.js";
import { agentConfig, teeConfig } from "./worker.js";

/**
 * Self-serve routes (docs/SPECIFICATION.md, Day 14 workstream 7): an agent's owner registers their agent
 * for ratings and asks for ratings by signing a message in their wallet, with no operator token.
 * What gets rated is one of Bonded's built-in scripted agent designs, run against the owner's own
 * vault and mandate (docs/AGENTS.md), or the owner's own agent, running on their servers and
 * connected to the Arena Gateway by `@bonded/runner` with a runner token made here
 * (docs/BRING-YOUR-OWN-AGENT.md).
 */

/**
 * The code hash of each design, as for the operator's agents. With Sentinel on, the worker
 * attests a combined hash instead (`ratedCodeHash` in worker.ts).
 */
export function selfServeCodeHash(kind: SelfServeKind): Hex {
  return keccak256(stringToBytes(`bonded/scripted-${kind}/v0`));
}

export interface SelfServeLimits {
  /** Runs of each attack in a self-serve rating (default 5, like the published scores). */
  repeats: number;
  /** One rating per agent per this many milliseconds (default one hour). */
  perAgentMs: number;
  /** Self-serve ratings per chain per 24 hours (default 40). */
  dailyRatings: number;
  /** Requests per client and in total, per window, across the self-serve routes. */
  requests: ConstructorParameters<typeof RateLimiter>[0];
  now?: () => number;
}

export const DEFAULT_SELF_SERVE_LIMITS: SelfServeLimits = {
  repeats: 5,
  perAgentMs: 60 * 60_000,
  dailyRatings: 40,
  requests: { perClient: 30, total: 600, windowMs: 10 * 60_000 },
};

const uint = z
  .string()
  .regex(/^\d{1,78}$/)
  .transform((v) => BigInt(v).toString());
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
const registerInput = z.union([
  z.strictObject({
    agentId: uint,
    vault: address,
    kind: z.enum(SELF_SERVE_KINDS),
    mandate: EvmMandate,
    /** Rate with Sentinel in front of the design (docs/SENTINEL.md). */
    sentinel: z.boolean().optional(),
    timestamp: z.number().int().positive(),
    signature,
  }),
  // The owner's own agent: what it declares about its code, how it acts, and its TEE if any.
  z.strictObject({
    agentId: uint,
    vault: address,
    kind: z.literal(REMOTE_KIND),
    mandate: EvmMandate,
    codeHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    mode: z.enum(REMOTE_MODES),
    tee: teeConfig.optional(),
    timestamp: z.number().int().positive(),
    signature,
  }),
]);
/** A signed request with nothing else in it: rate, create or revoke a runner token. */
const signedInput = z.strictObject({ timestamp: z.number().int().positive(), signature });

/** A self-serve request the API refuses, with the status and the reason to show the user. */
class Refused extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
  }
}

export function selfServeRoutes(
  app: Hono,
  options: {
    db: Database;
    chain: ServiceChain;
    limits?: Partial<SelfServeLimits>;
    /** The Arena Gateway's public URL, for the runner command the owner copies. */
    gatewayUrl?: string;
    /** Underwriting policy's cover caps by binding, shown with a remote agent's registration. */
    coverCaps?: Readonly<Record<BindingLevel, number>>;
  },
) {
  const { db, chain } = options;
  const d = chain.deployment;
  const limits = { ...DEFAULT_SELF_SERVE_LIMITS, ...options.limits };
  const now = () => (limits.now ?? Date.now)();
  const requests = new RateLimiter({ ...limits.requests, now });
  const rowId = (agentId: string) => `${d.chainId}:${agentId}`;

  /** The signer of `request`, if the signature is valid and recent. */
  async function signer(request: SelfServeRequest, sig: string): Promise<string> {
    const age = Math.floor(now() / 1000) - request.timestamp;
    if (age > SELF_SERVE_MAX_AGE_SECONDS || age < -60)
      throw new Refused(400, "the signed request has expired; sign it again");
    const recovered = await recoverMessageAddress({
      message: selfServeMessage(request),
      signature: sig as Hex,
    }).catch(() => undefined);
    if (!recovered) throw new Refused(400, "the signature is not valid");
    return recovered.toLowerCase();
  }

  /**
   * Whether the vault was created with exactly this mandate's enforced parameters. A matching
   * mandate hash isn't enough: the factory takes the hash and the parameters separately, so a
   * vault can carry the hash of one mandate while enforcing another (mode, limits, allowlists).
   * The creation call is the complete record of what the vault enforces, since its rules can't
   * change afterwards, so it is decoded and compared field by field.
   */
  async function createdWith(vault: Hex, mandate: EvmMandateType): Promise<string | undefined> {
    const [log] = await chain.read.getLogs({
      address: d.factory,
      event: getAbiItem({ abi: mandateVaultFactoryAbi, name: "VaultCreated" }),
      args: { vault },
      fromBlock: BigInt(d.deployedAtBlock),
      toBlock: "latest",
      strict: true,
    });
    if (!log) return "the vault's creation wasn't found";
    const tx = await chain.read.getTransaction({ hash: log.transactionHash });
    if (tx.to?.toLowerCase() !== d.factory.toLowerCase())
      return "create the vault by calling the factory directly, so its parameters can be checked";
    let call;
    try {
      call = decodeFunctionData({ abi: mandateVaultFactoryAbi, data: tx.input });
    } catch {
      return "the vault's creation call couldn't be read";
    }
    if (call.functionName !== "createVault") return "the vault's creation call couldn't be read";
    const norm = (v: unknown): unknown =>
      typeof v === "string"
        ? v.toLowerCase()
        : typeof v === "bigint"
          ? v.toString()
          : Array.isArray(v)
            ? v.map(norm)
            : v && typeof v === "object"
              ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]))
              : v;
    const expected = toEvmMandateParams(mandate);
    const actual = call.args[0] as Record<string, unknown>;
    const mismatched = (Object.keys(expected) as (keyof typeof expected)[]).filter(
      (k) => JSON.stringify(norm(expected[k])) !== JSON.stringify(norm(actual[k])),
    );
    return mismatched.length
      ? `the vault enforces different rules from this mandate (${mismatched.join(", ")})`
      : undefined;
  }

  const ownerOf = async (agentId: string) =>
    (
      await chain.read.readContract({
        address: d.registry,
        abi: bondedRegistryAbi,
        functionName: "agentOwner",
        args: [BigInt(agentId)],
      })
    ).toLowerCase();

  const handle = (fn: (c: Context) => Promise<Response>) => async (c: Context) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof Refused) return c.json({ error: e.message }, e.status);
      throw e;
    }
  };
  const limit = (c: Context) => {
    if (!requests.allow(clientAddress(c.req.raw.headers)))
      throw new Refused(429, "too many requests; try again in a few minutes");
  };

  /** Whether an agent is registered for self-serve ratings, and when it can be rated next. */
  app.get(
    "/self/agents/:id",
    handle(async (c) => {
      const agentId = uint.parse(c.req.param("id"));
      const record = await db.agentRecord(rowId(agentId));
      if (!record?.enabled) return c.json({ registered: false });
      const config = record.config as {
        kind: string;
        sentinel?: boolean;
        codeHash?: string;
        mode?: string;
        tee?: { url: string; composeHash: string };
      };
      const last = record.last_rating_at?.getTime();
      return c.json({
        registered: true,
        source: record.source,
        kind: config.kind,
        sentinel: config.sentinel === true,
        // The owner's own agent: what was declared, so the page can show it.
        ...(config.kind === REMOTE_KIND
          ? {
              codeHash: config.codeHash,
              mode: config.mode,
              tee: config.tee ?? null,
              // Underwriting policy, not score: the most cover it can hold, by binding.
              coverCaps: options.coverCaps ?? UNDERWRITING_COVER_CAP_USD,
            }
          : {}),
        owner: record.owner,
        lastRatingAt: last ? new Date(last).toISOString() : null,
        nextRatingAt:
          record.source === "user" && last
            ? new Date(last + limits.perAgentMs).toISOString()
            : null,
      });
    }),
  );

  /**
   * Register an agent for self-serve ratings. The owner signs which vault and which built-in
   * design, or for their own agent its declared code hash, mode and TEE; the mandate must hash to
   * the vault's on-chain mandate hash, so the rating is about exactly the rules that vault enforces.
   */
  app.post(
    "/self/agents",
    handle(async (c) => {
      limit(c);
      const input = registerInput.parse(await c.req.json());
      const hash = mandateHash(input.mandate);
      const base = {
        action: "register" as const,
        chainId: d.chainId,
        agentId: input.agentId,
        vault: input.vault,
        mandateHash: hash,
        timestamp: input.timestamp,
      };
      const who = await signer(
        input.kind === REMOTE_KIND
          ? {
              ...base,
              kind: REMOTE_KIND,
              remote: {
                codeHash: input.codeHash,
                mode: input.mode,
                ...(input.tee ? { tee: input.tee } : {}),
              },
            }
          : { ...base, kind: input.kind, ...(input.sentinel ? { sentinel: true } : {}) },
        input.signature,
      );
      if (input.mandate.chain.chainId !== d.chainId || input.mandate.agentId !== input.agentId)
        throw new Refused(400, "the mandate is for another chain or agent");
      if ((await ownerOf(input.agentId)) !== who)
        throw new Refused(403, "only the agent's owner can register it");
      const vault = input.vault as Hex;
      const [isVault, vaultAgentId, guardian, onchainHash] = await Promise.all([
        chain.read.readContract({
          address: d.factory,
          abi: mandateVaultFactoryAbi,
          functionName: "isVault",
          args: [vault],
        }),
        chain.read
          .readContract({ address: vault, abi: mandateVaultAbi, functionName: "agentId" })
          .catch(() => undefined),
        chain.read
          .readContract({ address: vault, abi: mandateVaultAbi, functionName: "guardian" })
          .catch(() => undefined),
        chain.read
          .readContract({ address: vault, abi: mandateVaultAbi, functionName: "mandateHash" })
          .catch(() => undefined),
      ]);
      if (!isVault) throw new Refused(400, "that address is not a Bonded vault");
      if (vaultAgentId?.toString() !== input.agentId)
        throw new Refused(400, "the vault belongs to another agent");
      if (guardian?.toLowerCase() !== who)
        throw new Refused(403, "only the vault's guardian can register it");
      if (onchainHash?.toLowerCase() !== hash.toLowerCase())
        throw new Refused(400, "the mandate doesn't match the vault's on-chain mandate");
      const mismatch = await createdWith(vault, input.mandate);
      if (mismatch) throw new Refused(400, mismatch);
      const config = agentConfig.parse(
        input.kind === REMOTE_KIND
          ? {
              kind: REMOTE_KIND,
              mandate: input.mandate,
              codeHash: input.codeHash,
              mode: input.mode,
              ...(input.tee ? { tee: input.tee } : {}),
              repeats: limits.repeats,
            }
          : {
              kind: input.kind,
              mandate: input.mandate,
              codeHash: selfServeCodeHash(input.kind),
              repeats: limits.repeats,
              ...(input.sentinel ? { sentinel: true } : {}),
            },
      );
      const previous = await db.agentRecord(rowId(input.agentId));
      const stored = await db.upsertUserAgent(d.chainId, input.agentId, who, config);
      if (!stored) throw new Refused(409, "this agent is managed by Bonded's operator");
      // A runner connected for another mode must reconnect, so the gateway checks it again.
      const before = previous?.config as { kind?: string; mode?: string } | undefined;
      if (
        before?.kind === REMOTE_KIND &&
        (config.kind !== REMOTE_KIND || before.mode !== config.mode)
      )
        await db.dropRunner(rowId(input.agentId));
      return c.json(
        {
          registered: true,
          agentId: input.agentId,
          kind: input.kind,
          sentinel: input.kind !== REMOTE_KIND && input.sentinel === true,
          ...(input.kind === REMOTE_KIND ? { mode: input.mode, tee: Boolean(input.tee) } : {}),
        },
        201,
      );
    }),
  );

  /** Queue a rating of a self-serve agent, signed by its owner. */
  app.post(
    "/self/agents/:id/rate",
    handle(async (c) => {
      limit(c);
      const agentId = uint.parse(c.req.param("id"));
      const input = signedInput.parse(await c.req.json());
      const who = await signer(
        { action: "rate", chainId: d.chainId, agentId, timestamp: input.timestamp },
        input.signature,
      );
      const record = await db.agentRecord(rowId(agentId));
      if (!record?.enabled || record.source !== "user")
        throw new Refused(404, "register the agent for ratings first");
      // The registry is the authority on ownership: an agent transferred since it was registered
      // can only be rated by its new owner.
      if ((await ownerOf(agentId)) !== who)
        throw new Refused(403, "only the agent's owner can ask for a rating");
      // The owner's own agent is rated through its runner, so one must be connected now.
      if (
        (record.config as { kind?: string }).kind === REMOTE_KIND &&
        !(await db.runnerIsConnected(rowId(agentId)))
      )
        throw new Refused(409, "no runner is connected for this agent; start it, then rate");
      const queued = await db.enqueueUserRating(rowId(agentId), d.chainId, {
        nowMs: now(),
        perAgentMs: limits.perAgentMs,
        dailyCap: limits.dailyRatings,
      });
      if ("refused" in queued)
        throw new Refused(
          429,
          queued.refused === "hourly"
            ? `one rating an hour per agent; next at ${queued.nextAt.toISOString()}`
            : "today's self-serve ratings are used up; try again tomorrow",
        );
      return c.json({ runId: queued.runId }, 202);
    }),
  );

  /**
   * The owner's own agent, ready for a runner token: registered as remote, and asked for by the
   * agent's owner (the registry's, not whoever registered it) with a fresh signature.
   */
  async function remoteOwner(c: Context, action: "runner-token" | "revoke-runner-token") {
    limit(c);
    const agentId = uint.parse(c.req.param("id"));
    const input = signedInput.parse(await c.req.json());
    const who = await signer(
      { action, chainId: d.chainId, agentId, timestamp: input.timestamp },
      input.signature,
    );
    const record = await db.agentRecord(rowId(agentId));
    if (!record?.enabled) throw new Refused(404, "register the agent for ratings first");
    if ((record.config as { kind?: string }).kind !== REMOTE_KIND)
      throw new Refused(409, "runner tokens are for agents registered as your own agent");
    if ((await ownerOf(agentId)) !== who)
      throw new Refused(403, "only the agent's owner can manage its runner token");
    return { agentId, who, timestamp: input.timestamp };
  }

  /**
   * Create a runner token, shown once. It replaces the agent's current token, and a runner
   * connected with the old one is dropped at its next heartbeat.
   */
  app.post(
    "/self/agents/:id/runner-token",
    handle(async (c) => {
      const { agentId, who, timestamp } = await remoteOwner(c, "runner-token");
      const token = newRunnerToken();
      const made = await db.createRunnerToken(rowId(agentId), {
        hash: runnerTokenHash(token),
        createdBy: who,
        signedAt: timestamp,
      });
      if ("refused" in made)
        throw new Refused(409, "that signed request was already used; sign again");
      c.header("Cache-Control", "no-store");
      return c.json(
        {
          token,
          tokenId: made.id,
          createdAt: made.createdAt.toISOString(),
          gatewayUrl: options.gatewayUrl ?? null,
        },
        201,
      );
    }),
  );

  /** Revoke the agent's runner token; a connected runner is dropped. */
  app.delete(
    "/self/agents/:id/runner-token",
    handle(async (c) => {
      const { agentId, timestamp } = await remoteOwner(c, "revoke-runner-token");
      const done = await db.revokeRunnerToken(rowId(agentId), timestamp);
      if ("refused" in done)
        throw new Refused(409, "that signed request was already used; sign again");
      return c.json({ revoked: done.revoked });
    }),
  );

  /**
   * The agent's runner token (whether there is one, never the token) and its runner: connected or
   * not, its version, mode and TEE URL, and the last rating the live loop had to skip.
   */
  app.get(
    "/self/agents/:id/runner",
    handle(async (c) => {
      const agentId = uint.parse(c.req.param("id"));
      const record = await db.agentRecord(rowId(agentId));
      if (!record?.enabled || (record.config as { kind?: string }).kind !== REMOTE_KIND)
        return c.json({ error: "this agent isn't registered as your own agent" }, 404);
      const status = await db.runnerStatus(rowId(agentId));
      const mode = (record.config as { mode: AgentMode }).mode;
      return c.json({
        ...status,
        // Why a runner that is there doesn't count, e.g. it was started in the other mode.
        problem: status.runner?.mode
          ? (helloProblem({ mode }, { mode: status.runner.mode }) ?? null)
          : null,
        gatewayUrl: options.gatewayUrl ?? null,
      });
    }),
  );
}
