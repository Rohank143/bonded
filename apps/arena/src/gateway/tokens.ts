import { createHash, randomBytes } from "node:crypto";
import { isWellFormedRunnerToken, RUNNER_TOKEN_PREFIX } from "@bonded/shared";

/**
 * The gateway's two kinds of secret:
 * - a runner token: long-lived, issued to an agent's operator, used only to open the runner's
 *   WebSocket. The gateway never stores one, only its hash.
 * - a capability token: 32 random bytes made for one episode. It is the only credential for that
 *   episode's tools, RPC and done endpoints, and it dies when the episode ends.
 */

/** A fresh runner token, for a local rating: the prefix and 32 random bytes, base64url. */
export function newRunnerToken(): string {
  return `${RUNNER_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** A fresh episode capability: 32 random bytes, base64url (43 characters, URL-safe). */
export function newCapabilityToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * What tokens are stored and looked up by: SHA-256, hex. Lookups go through the hash, so neither
 * kind of token is kept in memory or a database, and comparing hashes leaks nothing useful.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Who a runner token belongs to. */
export interface RunnerIdentity {
  /**
   * The agent the runner serves (in the rating service, its agent id). One runner per key: a
   * second connection with the same key replaces the first. A RemoteAgent names this key.
   */
  key: string;
}

/**
 * Checks a runner token. The gateway calls it when a runner connects and again on every
 * heartbeat, so a revoked token disconnects its runner within one heartbeat. The rating service
 * implements it against its database (stored hashes, revocation); StaticRunnerTokens is the
 * in-memory one for local ratings and tests.
 */
export interface RunnerTokenValidator {
  validate(token: string): Promise<RunnerIdentity | null>;
}

/** Runner tokens held in memory, by hash. */
export class StaticRunnerTokens implements RunnerTokenValidator {
  private readonly byHash = new Map<string, RunnerIdentity>();

  /** @param entries runner token → the key its runner serves */
  constructor(entries: Record<string, string> = {}) {
    for (const [token, key] of Object.entries(entries)) this.add(token, key);
  }

  add(token: string, key: string): void {
    if (!isWellFormedRunnerToken(token))
      throw new Error(
        `a runner token is ${RUNNER_TOKEN_PREFIX} followed by at least 16 base64url characters`,
      );
    this.byHash.set(hashToken(token), { key });
  }

  revoke(token: string): void {
    this.byHash.delete(hashToken(token));
  }

  async validate(token: string): Promise<RunnerIdentity | null> {
    return this.byHash.get(hashToken(token)) ?? null;
  }
}
