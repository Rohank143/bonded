import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getCollateral, PHALA_PCCS_URL, Quote, verify } from "@phala/dcap-qvl";
import { safeGet, UnsafeUrlError } from "./safe-fetch.js";
import {
  stripHexPrefix,
  teeArenaReportData,
  TeeEvidence,
  teeMeasurement,
  teeReportData,
  toHex32,
} from "@bonded/shared";

/**
 * Checks a TEE-hosted agent's evidence and turns it into the attestation's `teeMeasurement`.
 * See ADR-012. Nothing the agent says is trusted: the Intel-signed quote is the only authority,
 * and every other field has to match what the quote commits to.
 */

/** What the Arena needs from a verified quote. All hex, no prefix. */
export interface QuoteFacts {
  /** Intel's verdict on the machine's TCB, e.g. `UpToDate`. */
  status: string;
  mrTd: string;
  rtMr0: string;
  rtMr1: string;
  rtMr2: string;
  rtMr3: string;
  /** The 64 bytes the agent asked the hardware to sign. */
  reportData: string;
}

/** Verifies a quote's signature chain against Intel's collateral. Replaceable in tests. */
export type QuoteVerifier = (quote: Uint8Array) => Promise<QuoteFacts>;

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/**
 * The real verifier: Intel's certificate chain and revocation data, fetched through Phala's PCCS.
 * A malformed quote, or one that fails verification against that data, is a verification
 * failure. Failing to fetch the data throws `TeeUnavailableError`, because it says nothing about
 * the quote.
 */
export const verifyQuoteWithIntel: QuoteVerifier = async (quote) => {
  try {
    Quote.parse(Buffer.from(quote));
  } catch {
    throw new TeeVerificationError("the quote is malformed");
  }
  let collateral;
  try {
    collateral = await getCollateral(PHALA_PCCS_URL, Buffer.from(quote));
  } catch (error) {
    throw new TeeUnavailableError(
      `Intel's collateral could not be fetched: ${error instanceof Error ? error.message : "error"}`,
    );
  }
  const verified = verify(Buffer.from(quote), collateral, Date.now() / 1000);
  const td = verified.report.asTd10() ?? verified.report.asTd15()?.base;
  if (!td) throw new TeeVerificationError("the quote is not from an Intel TDX machine");
  return {
    status: verified.status,
    mrTd: toHex(td.mrTd),
    rtMr0: toHex(td.rtMr0),
    rtMr1: toHex(td.rtMr1),
    rtMr2: toHex(td.rtMr2),
    rtMr3: toHex(td.rtMr3),
    reportData: toHex(td.reportData),
  };
};

/** Intel statuses the Arena accepts. Out-of-date, revoked or unknown platforms are refused. */
export const DEFAULT_TCB_STATUSES: readonly string[] = ["UpToDate", "SWHardeningNeeded"];

export class TeeVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeeVerificationError";
  }
}

/**
 * The evidence could not be obtained: the agent didn't answer (a stopped VM, a network error, a
 * gateway error) or Intel's data couldn't be fetched. It says nothing about whether the agent is
 * what it claims, which is why it is not a `TeeVerificationError`.
 */
export class TeeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeeUnavailableError";
  }
}

export interface VerifiedTee {
  /** Goes into the attestation as `teeMeasurement`. */
  measurement: `0x${string}`;
  /** "arena" when this is an Arena key's evidence (then `evmAddress` is that key). */
  purpose?: "arena";
  composeHash: `0x${string}`;
  /** The dstack OS image the VM booted, as measured by the hardware. */
  osImageHash: string;
  codeHash: `0x${string}`;
  evmAddress: `0x${string}`;
  /** Absent for a TEE agent that only acts on EVM chains. */
  solanaPublicKey?: string;
  tcbStatus: string;
  mrTd: string;
  rtMr0: string;
  rtMr1: string;
  rtMr2: string;
}

/**
 * The dstack OS images the Arena accepts. The OS image hash is measured into RTMR3 (the
 * `os-image-hash` event), so the hardware vouches for which OS the VM booted. A development image
 * allows SSH into the VM, which lets the operator read the agent's keys, so it is not on this
 * list and is refused. Add a production image here, in a reviewed change, when Phala releases one.
 */
export const APPROVED_OS_IMAGES: Readonly<Record<string, string>> = {
  "dstack-0.5.9": "bd369a8c2f9edb2b52dad48ac8e0b32dde5f1337c423a506b48d07403a7d8033",
};

/** The dstack 0.5.9 development image, which allows SSH into the VM. Never accepted. */
export const DEV_OS_IMAGE_0_5_9 =
  "de9c74f0c85d0820ce075cb4a99f8e39f7b681be632907c5bf8bdc95ea72feb9";

export interface TeeExpectation {
  /** The challenge the Arena sent. */
  nonce: string;
  /** The code the Arena rated. The agent must be running exactly this. */
  codeHash: `0x${string}`;
  /** The compose hash the operator published for that code's deployment. */
  composeHash: string;
  verifyQuote?: QuoteVerifier;
  acceptedStatuses?: readonly string[];
  /** OS image hashes to accept (default: `APPROVED_OS_IMAGES`). */
  approvedOsImages?: readonly string[];
  /**
   * Expect an Arena key's evidence for this key id (a chain-mode rating), instead of the
   * production keys' evidence. Each kind is refused where the other is expected.
   */
  arenaKeyId?: string;
}

interface EventLogEntry {
  imr: number;
  event_type: number;
  digest: string;
  event: string;
  event_payload: string;
}

const INIT_RTMR = Buffer.alloc(48);

/** dstack's extend rule: `new = sha384(old || digest)`, with the digest zero-padded to 48 bytes. */
function replayRtmr(digests: string[]): string {
  let mr = INIT_RTMR;
  for (const digest of digests) {
    const bytes = Buffer.from(stripHexPrefix(digest), "hex");
    const padded = Buffer.concat([bytes, Buffer.alloc(Math.max(0, 48 - bytes.length))]);
    mr = createHash("sha384").update(mr).update(padded).digest();
  }
  return mr.toString("hex");
}

/** The digest dstack records for a runtime event: `sha384(type (u32 LE) ":" event ":" payload)`. */
function runtimeEventDigest(entry: EventLogEntry): string {
  const type = Buffer.alloc(4);
  type.writeUInt32LE(entry.event_type);
  return createHash("sha384")
    .update(type)
    .update(":")
    .update(entry.event)
    .update(":")
    .update(Buffer.from(stripHexPrefix(entry.event_payload), "hex"))
    .digest("hex");
}

/**
 * The digest the hardware extended for an event. dstack's guest agent leaves `digest` empty for
 * runtime events (the RTMR3 ones), so it is computed from the event itself. Because the replay
 * must then reach the quote's RTMR3, the event's name and payload are bound by the hardware.
 */
function digestOf(entry: EventLogEntry): string {
  return entry.digest === "" ? runtimeEventDigest(entry) : entry.digest;
}

const HEX = /^[0-9a-fA-F]*$/;
const isHex = (v: unknown, maxBytes: number): v is string =>
  typeof v === "string" && v.length % 2 === 0 && v.length <= maxBytes * 2 && HEX.test(v);

/**
 * Parses the event log strictly. Anything that isn't exactly the shape dstack emits is a
 * verification failure, not an exception: a hostile agent controls this string.
 */
function parseEventLog(raw: string): EventLogEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TeeVerificationError("the event log is not JSON");
  }
  if (!Array.isArray(parsed)) throw new TeeVerificationError("the event log is not a list");
  if (parsed.length > 10_000) throw new TeeVerificationError("the event log is too long");
  return parsed.map((entry: unknown) => {
    const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    if (
      !Number.isInteger(e.imr) ||
      (e.imr as number) < 0 ||
      (e.imr as number) > 3 ||
      !Number.isInteger(e.event_type) ||
      (e.event_type as number) < 0 ||
      (e.event_type as number) > 0xffffffff ||
      !isHex(e.digest, 48) ||
      typeof e.event !== "string" ||
      !isHex(e.event_payload, 1 << 20)
    )
      throw new TeeVerificationError("the event log has a malformed entry");
    return e as unknown as EventLogEntry;
  });
}

const sameHex = (a: string, b: string): boolean => {
  const x = Buffer.from(stripHexPrefix(a), "hex");
  const y = Buffer.from(stripHexPrefix(b), "hex");
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Verifies one piece of TEE evidence. Throws `TeeVerificationError` with the reason on any
 * failure, so a rating can never carry a measurement that wasn't checked:
 *
 * 1. the quote verifies against Intel's certificate chain and the machine's TCB is acceptable;
 * 2. the quote's report data commits to this code, its session keys (the Solana one if it has one) and our nonce, so the keys
 *    were generated by that code in this machine and the quote is fresh;
 * 3. the event log replays to the quote's RTMRs, so it is the log the hardware measured;
 * 4. the log's compose-hash event is the compose hash the operator published and the evidence
 *    reports, so the hardware vouches for which app is running.
 */
export async function verifyTeeEvidence(
  raw: unknown,
  expected: TeeExpectation,
): Promise<VerifiedTee> {
  const parsed = TeeEvidence.safeParse(raw);
  if (!parsed.success) throw new TeeVerificationError("the evidence is malformed");
  const evidence = parsed.data;
  const fail = (reason: string): never => {
    throw new TeeVerificationError(reason);
  };

  if (!sameHex(evidence.nonce, expected.nonce)) fail("the evidence answers a different challenge");
  if (expected.arenaKeyId) {
    if (
      evidence.purpose !== "arena" ||
      !evidence.keyId ||
      !sameHex(evidence.keyId, expected.arenaKeyId)
    )
      fail("the evidence is not for the Arena key this rating asked for");
  } else if (evidence.purpose !== undefined || evidence.keyId !== undefined)
    fail("the evidence is for an Arena key, not the agent's production keys");
  if (!sameHex(evidence.codeHash, expected.codeHash))
    fail("the agent reports different code than the one that was rated");
  if (!sameHex(evidence.composeHash, expected.composeHash))
    fail("the agent reports a different deployment than the one published");

  const verify = expected.verifyQuote ?? verifyQuoteWithIntel;
  let facts: QuoteFacts;
  try {
    facts = await verify(Buffer.from(stripHexPrefix(evidence.quote), "hex"));
  } catch (error) {
    if (error instanceof TeeVerificationError || error instanceof TeeUnavailableError) throw error;
    return fail(`the quote did not verify: ${error instanceof Error ? error.message : "error"}`);
  }
  if (!(expected.acceptedStatuses ?? DEFAULT_TCB_STATUSES).includes(facts.status))
    fail(`the machine's TCB status is ${facts.status}`);

  const committed = expected.arenaKeyId
    ? teeArenaReportData({
        codeHash: evidence.codeHash as `0x${string}`,
        evmAddress: evidence.evmAddress as `0x${string}`,
        keyId: expected.arenaKeyId,
        nonce: evidence.nonce,
      })
    : teeReportData({
        codeHash: evidence.codeHash as `0x${string}`,
        evmAddress: evidence.evmAddress as `0x${string}`,
        solanaPublicKey: evidence.solanaPublicKey,
        nonce: evidence.nonce,
      });
  // dstack zero-pads the report data to 64 bytes.
  const expectedData = `${stripHexPrefix(committed)}${"0".repeat(64)}`;
  if (!sameHex(facts.reportData, expectedData))
    fail("the quote does not commit to this code, these keys and this challenge");

  // Everything below handles text the agent controls. Whatever goes wrong with it is a verification
  // failure, never an untyped exception (which a caller could mistake for an outage).
  try {
    const log = parseEventLog(evidence.eventLog);
    const replayed = [0, 1, 2, 3].map((imr) =>
      replayRtmr(log.filter((e) => e.imr === imr).map(digestOf)),
    );
    const quoted = [facts.rtMr0, facts.rtMr1, facts.rtMr2, facts.rtMr3];
    replayed.forEach((value, i) => {
      if (!sameHex(value, quoted[i]!)) fail(`the event log does not replay to RTMR${i}`);
    });

    // An RTMR3 event is only vouched for by the hardware when its digest is the one computed from
    // its own name and payload.
    const measuredEvent = (name: string): string => {
      const events = log.filter((e) => e.imr === 3 && e.event === name);
      if (events.length !== 1) return fail(`the event log must record exactly one ${name} event`);
      const event = events[0]!;
      if (!sameHex(runtimeEventDigest(event), digestOf(event)))
        return fail(`the ${name} event does not match its digest`);
      return event.event_payload;
    };

    if (!sameHex(measuredEvent("compose-hash"), expected.composeHash))
      fail("the hardware measured a different compose hash than the one published");
    const osImageHash = measuredEvent("os-image-hash");
    const approved = expected.approvedOsImages ?? Object.values(APPROVED_OS_IMAGES);
    if (!approved.some((hash) => sameHex(hash, osImageHash)))
      fail("the VM booted an OS image that is not an approved production image");

    return {
      measurement: teeMeasurement({
        mrTd: facts.mrTd,
        rtMr0: facts.rtMr0,
        rtMr1: facts.rtMr1,
        rtMr2: facts.rtMr2,
        composeHash: expected.composeHash,
      }),
      composeHash: toHex32(expected.composeHash),
      osImageHash: stripHexPrefix(osImageHash).toLowerCase(),
      codeHash: evidence.codeHash as `0x${string}`,
      evmAddress: evidence.evmAddress as `0x${string}`,
      ...(evidence.solanaPublicKey ? { solanaPublicKey: evidence.solanaPublicKey } : {}),
      ...(expected.arenaKeyId ? { purpose: "arena" as const } : {}),
      tcbStatus: facts.status,
      mrTd: facts.mrTd,
      rtMr0: facts.rtMr0,
      rtMr1: facts.rtMr1,
      rtMr2: facts.rtMr2,
    };
  } catch (error) {
    if (error instanceof TeeVerificationError) throw error;
    throw new TeeVerificationError("the evidence could not be processed");
  }
}

export interface FetchTeeOptions extends Omit<TeeExpectation, "nonce"> {
  /** The agent's base URL, e.g. the Phala-assigned `https://<app-id>-8080.dstack-....phala.network`. */
  url: string;
  timeoutMs?: number;
  /**
   * Allow a loopback address, over plain http too: a local TEE simulator. Never set it for a URL
   * an operator gave a server (the rating service): it would let them aim the Arena at itself.
   */
  allowLoopback?: boolean;
  /** For tests: replaces the network call (the URL checks above it still apply). */
  fetch?: typeof fetch;
}

/** Most of the evidence the Arena reads (a quote and event log are tens of KB). */
const TEE_EVIDENCE_MAX_BYTES = 512 * 1024;

/**
 * Challenges a live TEE agent with a fresh nonce and verifies what it returns. The URL is the
 * operator's, so it is fetched as untrusted (safe-fetch.ts): https only, public addresses only
 * (loopback only with `allowLoopback`), no redirects, a time limit and a size limit.
 */
export async function attestTeeAgent(options: FetchTeeOptions): Promise<VerifiedTee> {
  let url: URL;
  try {
    url = new URL("/attestation", options.url);
  } catch {
    throw new TeeVerificationError("the TEE agent's URL is not valid");
  }
  const nonce = `0x${randomBytes(32).toString("hex")}`;
  url.searchParams.set("nonce", nonce);
  if (options.arenaKeyId) {
    url.searchParams.set("purpose", "arena");
    url.searchParams.set("key", options.arenaKeyId);
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  let status: number;
  let text: string;
  try {
    if (options.fetch) {
      if (url.protocol !== "https:" && !(options.allowLoopback && url.protocol === "http:"))
        throw new UnsafeUrlError("the URL must use https");
      const response = await options.fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      status = response.status;
      text = await response.text();
    } else {
      ({ status, text } = await safeGet(url, {
        timeoutMs,
        maxBytes: TEE_EVIDENCE_MAX_BYTES,
        ...(options.allowLoopback ? { allowLoopback: true } : {}),
      }));
    }
  } catch (error) {
    if (error instanceof UnsafeUrlError)
      throw new TeeVerificationError(`the TEE agent's URL was refused: ${error.message}`);
    throw new TeeUnavailableError("the TEE agent did not answer");
  }
  if (status < 200 || status >= 300)
    throw new TeeUnavailableError(`the TEE agent answered ${status}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new TeeVerificationError("the evidence is not JSON");
  }
  return verifyTeeEvidence(body, { ...options, nonce });
}
