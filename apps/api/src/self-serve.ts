import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Database } from "@bonded/db";
import {
  bondedRegistryAbi,
  EvmMandate,
  mandateHash,
  mandateVaultAbi,
  mandateVaultFactoryAbi,
  SELF_SERVE_KINDS,
  SELF_SERVE_MAX_AGE_SECONDS,
  selfServeMessage,
  toEvmMandateParams,
  type EvmMandate as EvmMandateType,
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

/**
 * Self-serve routes (docs/PLAN.md, Day 14 workstream 7): an agent's owner registers their agent
 * for ratings and asks for ratings by signing a message in their wallet, with no operator token.
 * What gets rated is one of Bonded's built-in scripted agent designs, run against the owner's own
 * vault and mandate (docs/AGENTS.md); rating the owner's own agent code is issue #84.
 */

/** The code hash each design is rated under, as for the operator's agents. */
const CODE_HASH: Record<SelfServeKind, Hex> = {
  vulnerable: keccak256(stringToBytes("bonded/scripted-vulnerable/v0")),
  partial: keccak256(stringToBytes("bonded/scripted-partial/v0")),
  hardened: keccak256(stringToBytes("bonded/scripted-hardened/v0")),
};

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
const registerInput = z.strictObject({
  agentId: uint,
  vault: address,
  kind: z.enum(SELF_SERVE_KINDS),
  mandate: EvmMandate,
  timestamp: z.number().int().positive(),
  signature,
});
const rateInput = z.strictObject({ timestamp: z.number().int().positive(), signature });

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
  options: { db: Database; chain: ServiceChain; limits?: Partial<SelfServeLimits> },
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
      const config = record.config as { kind: string };
      const last = record.last_rating_at?.getTime();
      return c.json({
        registered: true,
        source: record.source,
        kind: config.kind,
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
   * design; the mandate must hash to the vault's on-chain mandate hash, so the rating is about
   * exactly the rules that vault enforces.
   */
  app.post(
    "/self/agents",
    handle(async (c) => {
      limit(c);
      const input = registerInput.parse(await c.req.json());
      const hash = mandateHash(input.mandate);
      const who = await signer(
        {
          action: "register",
          chainId: d.chainId,
          agentId: input.agentId,
          vault: input.vault,
          kind: input.kind,
          mandateHash: hash,
          timestamp: input.timestamp,
        },
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
      const stored = await db.upsertUserAgent(d.chainId, input.agentId, who, {
        kind: input.kind,
        mandate: input.mandate,
        codeHash: CODE_HASH[input.kind],
        repeats: limits.repeats,
      });
      if (!stored) throw new Refused(409, "this agent is managed by Bonded's operator");
      return c.json({ registered: true, agentId: input.agentId, kind: input.kind }, 201);
    }),
  );

  /** Queue a rating of a self-serve agent, signed by its owner. */
  app.post(
    "/self/agents/:id/rate",
    handle(async (c) => {
      limit(c);
      const agentId = uint.parse(c.req.param("id"));
      const input = rateInput.parse(await c.req.json());
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
}
