import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getCollateralAndVerify } from "@phala/dcap-qvl";
import {
  stripHexPrefix,
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

/** The real verifier: Intel's certificate chain and revocation data, fetched through Phala's PCCS. */
export const verifyQuoteWithIntel: QuoteVerifier = async (quote) => {
  const verified = await getCollateralAndVerify(quote);
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

export interface VerifiedTee {
  /** Goes into the attestation as `teeMeasurement`. */
  measurement: `0x${string}`;
  composeHash: `0x${string}`;
  codeHash: `0x${string}`;
  evmAddress: `0x${string}`;
  solanaPublicKey: string;
  tcbStatus: string;
  mrTd: string;
  rtMr0: string;
  rtMr1: string;
  rtMr2: string;
}

export interface TeeExpectation {
  /** The challenge the Arena sent. */
  nonce: string;
  /** The code the Arena rated. The agent must be running exactly this. */
  codeHash: `0x${string}`;
  /** The compose hash the operator published for that code's deployment. */
  composeHash: string;
  verifyQuote?: QuoteVerifier;
  acceptedStatuses?: readonly string[];
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

function parseEventLog(raw: string): EventLogEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TeeVerificationError("the event log is not JSON");
  }
  if (!Array.isArray(parsed)) throw new TeeVerificationError("the event log is not a list");
  return parsed.map((entry) => {
    const e = entry as Partial<EventLogEntry>;
    if (
      typeof e.imr !== "number" ||
      typeof e.event_type !== "number" ||
      typeof e.digest !== "string" ||
      typeof e.event !== "string" ||
      typeof e.event_payload !== "string"
    )
      throw new TeeVerificationError("the event log has a malformed entry");
    return e as EventLogEntry;
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
 * 2. the quote's report data commits to this code, both session keys and our nonce, so the keys
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
  if (!sameHex(evidence.codeHash, expected.codeHash))
    fail("the agent reports different code than the one that was rated");
  if (!sameHex(evidence.composeHash, expected.composeHash))
    fail("the agent reports a different deployment than the one published");

  const verify = expected.verifyQuote ?? verifyQuoteWithIntel;
  let facts: QuoteFacts;
  try {
    facts = await verify(Buffer.from(stripHexPrefix(evidence.quote), "hex"));
  } catch (error) {
    if (error instanceof TeeVerificationError) throw error;
    return fail(`the quote did not verify: ${error instanceof Error ? error.message : "error"}`);
  }
  if (!(expected.acceptedStatuses ?? DEFAULT_TCB_STATUSES).includes(facts.status))
    fail(`the machine's TCB status is ${facts.status}`);

  const committed = teeReportData({
    codeHash: evidence.codeHash as `0x${string}`,
    evmAddress: evidence.evmAddress as `0x${string}`,
    solanaPublicKey: evidence.solanaPublicKey,
    nonce: evidence.nonce,
  });
  // dstack zero-pads the report data to 64 bytes.
  const expectedData = `${stripHexPrefix(committed)}${"0".repeat(64)}`;
  if (!sameHex(facts.reportData, expectedData))
    fail("the quote does not commit to this code, these keys and this challenge");

  const log = parseEventLog(evidence.eventLog);
  const replayed = [0, 1, 2, 3].map((imr) =>
    replayRtmr(log.filter((e) => e.imr === imr).map(digestOf)),
  );
  const quoted = [facts.rtMr0, facts.rtMr1, facts.rtMr2, facts.rtMr3];
  replayed.forEach((value, i) => {
    if (!sameHex(value, quoted[i]!)) fail(`the event log does not replay to RTMR${i}`);
  });

  const composeEvents = log.filter((e) => e.imr === 3 && e.event === "compose-hash");
  if (composeEvents.length !== 1) fail("the event log must record exactly one compose hash");
  const composeEvent = composeEvents[0]!;
  if (!sameHex(runtimeEventDigest(composeEvent), digestOf(composeEvent)))
    fail("the compose-hash event does not match its digest");
  if (!sameHex(composeEvent.event_payload, expected.composeHash))
    fail("the hardware measured a different compose hash than the one published");

  return {
    measurement: teeMeasurement({
      mrTd: facts.mrTd,
      rtMr0: facts.rtMr0,
      rtMr1: facts.rtMr1,
      rtMr2: facts.rtMr2,
      composeHash: expected.composeHash,
    }),
    composeHash: toHex32(expected.composeHash),
    codeHash: evidence.codeHash as `0x${string}`,
    evmAddress: evidence.evmAddress as `0x${string}`,
    solanaPublicKey: evidence.solanaPublicKey,
    tcbStatus: facts.status,
    mrTd: facts.mrTd,
    rtMr0: facts.rtMr0,
    rtMr1: facts.rtMr1,
    rtMr2: facts.rtMr2,
  };
}

export interface FetchTeeOptions extends Omit<TeeExpectation, "nonce"> {
  /** The agent's base URL, e.g. the Phala-assigned `https://<app-id>-8080.dstack-....phala.network`. */
  url: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Challenges a live TEE agent with a fresh nonce and verifies what it returns. Rejects anything
 * but https (plain http only for localhost, where the simulator runs).
 */
export async function attestTeeAgent(options: FetchTeeOptions): Promise<VerifiedTee> {
  const url = new URL("/attestation", options.url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    throw new TeeVerificationError("the TEE agent's URL must use https");
  const nonce = `0x${randomBytes(32).toString("hex")}`;
  url.searchParams.set("nonce", nonce);
  const response = await (options.fetch ?? fetch)(url, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  if (!response.ok) throw new TeeVerificationError(`the TEE agent answered ${response.status}`);
  return verifyTeeEvidence(await response.json(), { ...options, nonce });
}
