/**
 * Agent URL request signatures: how an agent knows a request really comes from Bonded.
 *
 * Bonded signs every call to an Agent URL with the agent's secret:
 * - `bonded-timestamp`: unix seconds;
 * - `bonded-signature`: `v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>` (up to four,
 *   comma-separated, while a secret is rotated).
 *
 * The scheme lives in @bondedhq/shared (`@bondedhq/shared/agent-url`, which the gateway signs with);
 * these are the SDK's names for it. Web Crypto only, so it runs in Node, Bun, Deno, Cloudflare
 * Workers and edge runtimes, and the comparison is Web Crypto's constant-time HMAC verify.
 */
import {
  AGENT_URL_SIGNATURE_HEADER,
  AGENT_URL_TIMESTAMP_HEADER,
  AGENT_URL_TOLERANCE_SECONDS,
  signAgentUrlRequest,
  verifyAgentUrlRequest,
} from "@bondedhq/shared/agent-url";

export const SIGNATURE_HEADER = AGENT_URL_SIGNATURE_HEADER;
export const TIMESTAMP_HEADER = AGENT_URL_TIMESTAMP_HEADER;
/** How far a request's timestamp may be from the agent's clock, either way. */
export const SIGNATURE_TOLERANCE_SECONDS = AGENT_URL_TOLERANCE_SECONDS;

/**
 * Signs a body as Bonded does: the two headers to send with it. For testing your endpoint
 * locally; Bonded signs real calls itself.
 */
export async function signBondedRequest(
  secret: string,
  body: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): Promise<{ "bonded-timestamp": string; "bonded-signature": string }> {
  const headers = await signAgentUrlRequest(secret, body, timestamp * 1000);
  return {
    "bonded-timestamp": headers[TIMESTAMP_HEADER]!,
    "bonded-signature": headers[SIGNATURE_HEADER]!,
  };
}

export type SignatureCheck = { ok: true; timestamp: number } | { ok: false; reason: string };

/**
 * Checks a request's signature only: the timestamp is within `toleranceSeconds` of now and one of
 * the header's `v1=` signatures is the body's HMAC under `secret` (or one of several secrets).
 * It doesn't look at the body or check for replays; `createBondedHandler` does both.
 */
export async function verifyBondedSignature(input: {
  secret: string | string[];
  body: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  /** Unix seconds. Default: now. */
  now?: number;
  toleranceSeconds?: number;
}): Promise<SignatureCheck> {
  const result = await verifyAgentUrlRequest({
    secret: input.secret,
    body: input.body,
    headers: {
      [TIMESTAMP_HEADER]: input.timestamp ?? undefined,
      [SIGNATURE_HEADER]: input.signature ?? undefined,
    },
    ...(input.now !== undefined ? { nowMs: input.now * 1000 } : {}),
    ...(input.toleranceSeconds !== undefined ? { toleranceSeconds: input.toleranceSeconds } : {}),
  });
  if (result.ok) return { ok: true, timestamp: result.timestamp };
  // 400 means the signature matched but the body isn't one of Bonded's messages.
  if (result.status === 400) return { ok: true, timestamp: Number(input.timestamp) };
  return { ok: false, reason: result.reason };
}
