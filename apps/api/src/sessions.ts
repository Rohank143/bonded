import { createHash, randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Database } from "@bonded/db";
import { SELF_SERVE_MAX_AGE_SECONDS, selfServeMessage } from "@bonded/shared";
import { recoverMessageAddress, type Hex } from "viem";
import { Refused, handle } from "./refused.js";
import type { RateLimiter } from "./rate-limit.js";
import { clientAddress } from "./rate-limit.js";

/**
 * Owner sessions (bring your own agent, round 2): a wallet signs "Bonded: start preview" once (an
 * EIP-191 message from `selfServeMessage`) and gets a session token for the preview, check, Agent
 * URL and notification routes, sent as `Authorization: Bearer bonded_ss_...`. A preview needs no
 * on-chain registration, so the wallet is the identity. Only the token's sha256 is stored; each
 * signature opens one session; a session lasts 12 hours and can be ended early.
 */

export const SESSION_PREFIX = "bonded_ss_";
export const SESSION_TTL_MS = 12 * 3_600_000;
/** Sessions one wallet may open per hour. */
export const SESSIONS_PER_WALLET_HOURLY = 20;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const signInInput = z.strictObject({
  /** Optional: when sent, it must be this API's chain. */
  chainId: z.number().int().positive().optional(),
  wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  timestamp: z.number().int().positive(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});

/**
 * What makes a signed request "used": who signed and exactly what, not the signature's bytes. The
 * same message signed again (or one signature written another way: v as 0/1 or 27/28, high or
 * low s) is the same request, so it is refused as a replay.
 */
export function signedRequestKey(signer: string, message: string): string {
  return sha256(`${signer.toLowerCase()}\n${message}`);
}

/** Reads the caller's session: its wallet, or a 401 the web app can act on. */
export type SessionWallet = (c: Context) => Promise<string>;

export function sessionRoutes(
  app: Hono,
  options: { db: Database; chainId: number; now: () => number; writes: RateLimiter },
): SessionWallet {
  const { db, chainId, now } = options;

  const bearer = (c: Context) => {
    const header = c.req.header("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    return /^bonded_ss_[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
  };
  const wallet: SessionWallet = async (c) => {
    const token = bearer(c);
    if (!token) throw new Refused(401, "sign in with your wallet first");
    const session = await db.session(sha256(token), chainId);
    if (!session) throw new Refused(401, "your session has ended; sign in again");
    return session.wallet;
  };

  /**
   * Sign in: exchange a fresh "Bonded: start preview" signature for a session token, shown once.
   * The same route under both paths.
   */
  const signIn = handle(async (c) => {
    if (!options.writes.allow(clientAddress(c.req.raw.headers)))
      throw new Refused(429, "too many requests; try again in a few minutes");
    const input = signInInput.parse(await c.req.json());
    if (input.chainId !== undefined && input.chainId !== chainId)
      throw new Refused(400, "that sign-in is for another chain");
    const age = Math.floor(now() / 1000) - input.timestamp;
    if (age > SELF_SERVE_MAX_AGE_SECONDS || age < -60)
      throw new Refused(400, "the signed request has expired; sign it again");
    const message = selfServeMessage({
      action: "sign-in",
      chainId,
      wallet: input.wallet,
      timestamp: input.timestamp,
    });
    const recovered = await recoverMessageAddress({
      message,
      signature: input.signature as Hex,
    }).catch(() => undefined);
    if (!recovered) throw new Refused(400, "the signature is not valid");
    if (recovered.toLowerCase() !== input.wallet.toLowerCase())
      throw new Refused(403, "the signature isn't from that wallet");
    const token = `${SESSION_PREFIX}${randomBytes(32).toString("base64url")}`;
    const opened = await db.createSession(
      {
        tokenHash: sha256(token),
        chainId,
        wallet: recovered,
        signatureHash: signedRequestKey(recovered, message),
        ttlMs: SESSION_TTL_MS,
      },
      SESSIONS_PER_WALLET_HOURLY,
    );
    if ("refused" in opened)
      throw opened.refused === "replayed"
        ? new Refused(409, "that signed request was already used; sign again")
        : new Refused(429, "too many sign-ins from this wallet; try again in an hour");
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        session: token,
        wallet: recovered.toLowerCase(),
        expiresAt: opened.expiresAt.toISOString(),
      },
      201,
    );
  });
  app.post("/previews/session", signIn);
  app.post("/self/session", signIn);

  /** Who the session is for. */
  for (const path of ["/self/session", "/previews/session"])
    app.get(
      path,
      handle(async (c) => {
        const token = bearer(c);
        const session = token ? await db.session(sha256(token), chainId) : undefined;
        if (!session) throw new Refused(401, "not signed in");
        return c.json({ wallet: session.wallet, expiresAt: session.expiresAt.toISOString() });
      }),
    );

  /** Sign out: the session stops working at once. */
  for (const path of ["/self/session", "/previews/session"])
    app.delete(
      path,
      handle(async (c) => {
        const token = bearer(c);
        if (!token) throw new Refused(401, "not signed in");
        return c.json({ signedOut: await db.revokeSession(sha256(token)) });
      }),
    );

  return wallet;
}
