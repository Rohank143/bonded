/**
 * Agent URL request signatures: how an agent knows a request really comes from Bonded.
 *
 * Bonded signs every call to an Agent URL with the agent's secret:
 * - `bonded-timestamp`: unix seconds;
 * - `bonded-signature`: `v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`.
 *
 * Uses Web Crypto only, so it runs in Node, Bun, Deno, Cloudflare Workers and edge runtimes. The
 * comparison is Web Crypto's own HMAC verify, which is constant-time.
 *
 * NOTE: the gateway's canonical sign/verify helpers live in @bonded/shared (added with the Agent
 * URL transport). This module implements the same scheme for agents; keep the two in step.
 */

export const SIGNATURE_HEADER = "bonded-signature";
export const TIMESTAMP_HEADER = "bonded-timestamp";
/** How far a request's timestamp may be from the agent's clock, either way. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

async function hmacKey(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

const toHex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

function fromHex(hex: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return undefined;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * Signs a body as Bonded does: the two headers to send with it. For testing your endpoint
 * locally (and for Bonded's own tests); Bonded signs real calls itself.
 */
export async function signBondedRequest(
  secret: string,
  body: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): Promise<{ [TIMESTAMP_HEADER]: string; [SIGNATURE_HEADER]: string }> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    encoder.encode(`${timestamp}.${body}`),
  );
  return { [TIMESTAMP_HEADER]: String(timestamp), [SIGNATURE_HEADER]: `v1=${toHex(mac)}` };
}

export type SignatureCheck =
  | { ok: true; timestamp: number }
  | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" };

/**
 * Checks a request's signature: the timestamp is within `toleranceSeconds` of now and one of the
 * header's `v1=` signatures is the body's HMAC under `secret`. Does not check for replays; the
 * handler does, by remembering the (timestamp, signature) pairs it accepted.
 */
export async function verifyBondedSignature(input: {
  secret: string;
  body: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  /** Unix seconds. Default: now. */
  now?: number;
  toleranceSeconds?: number;
}): Promise<SignatureCheck> {
  if (!input.timestamp || !input.signature) return { ok: false, reason: "missing" };
  if (!/^\d{1,12}$/.test(input.timestamp)) return { ok: false, reason: "malformed" };
  const timestamp = Number(input.timestamp);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS))
    return { ok: false, reason: "stale" };
  // A header may carry several signatures (e.g. while a secret is rotated): any one may match.
  const candidates = input.signature
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="))
    .map((part) => fromHex(part.slice(3)));
  if (candidates.length === 0 || candidates.length > 4 || candidates.some((c) => !c))
    return { ok: false, reason: "malformed" };
  const key = await hmacKey(input.secret, "verify");
  const data = encoder.encode(`${input.timestamp}.${input.body}`);
  for (const candidate of candidates)
    if (await crypto.subtle.verify("HMAC", key, candidate!, data)) return { ok: true, timestamp };
  return { ok: false, reason: "mismatch" };
}
