import { concatHex, keccak256, stringToHex } from "viem";
import { z } from "zod";
import { bytes32, evmAddress } from "./schemas/common.js";
import { ZERO_BYTES32 } from "./schemas/attestation.js";

/**
 * What a TEE-hosted agent shows the Arena, and how the Arena turns it into the attestation's
 * `teeMeasurement`. See ADR-012 and docs/PLAN.md Section 12.
 */

const hex = z.string().regex(/^(0x)?[0-9a-fA-F]*$/, "hex string");
const hex32 = z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/, "32-byte hex string");
/** A base58 Solana public key (32 bytes). */
const solanaKey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "base58 public key");

/** Domain tag mixed into the quote's report data, so the quote can't be reused for anything else. */
export const TEE_REPORT_DOMAIN = "bonded-tee-v1";

/** The evidence endpoint's response. Everything here is checked by the Arena; none of it is trusted. */
export const TeeEvidence = z.strictObject({
  /** The TDX quote, hex. */
  quote: hex,
  /** dstack's event log for this quote, as the JSON string the guest agent returns. */
  eventLog: z.string(),
  /** Hash of the app-compose file the agent was deployed from. */
  composeHash: hex32,
  /** Hash of the agent code the Arena rated (baked into the image, so the image digest covers it). */
  codeHash: bytes32,
  /** The agent's session key on EVM chains, derived inside the TEE. */
  evmAddress,
  /** The agent's session key on Solana, derived inside the TEE. */
  solanaPublicKey: solanaKey,
  /** The Arena's challenge, echoed back so an old quote can't be replayed. */
  nonce: hex32,
});
export type TeeEvidence = z.infer<typeof TeeEvidence>;

export function stripHexPrefix(value: string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

export function toHex32(value: string): `0x${string}` {
  return `0x${stripHexPrefix(value).toLowerCase()}`;
}

/**
 * The 32 bytes the TEE puts in the quote's report data: a hash of the code it runs, both session
 * keys and the Arena's nonce. Binding them in one hash is what ties "this key" to "this code".
 */
export function teeReportData(input: {
  codeHash: `0x${string}`;
  evmAddress: `0x${string}`;
  solanaPublicKey: string;
  nonce: string;
}): `0x${string}` {
  return keccak256(
    concatHex([
      stringToHex(TEE_REPORT_DOMAIN),
      input.codeHash,
      input.evmAddress,
      stringToHex(input.solanaPublicKey),
      toHex32(input.nonce),
    ]),
  );
}

/** The TDX measurements and app identity that make up the attestation's `teeMeasurement`. */
export interface TeeMeasured {
  mrTd: string;
  rtMr0: string;
  rtMr1: string;
  rtMr2: string;
  composeHash: string;
}

/**
 * The attestation's `teeMeasurement`: a hash of the VM measurements that fix the platform image
 * (MRTD, RTMR0 to RTMR2) and the compose hash. RTMR3 is left out because it also records
 * per-instance events (instance id, boot time), so it would differ between two copies of the same
 * app; the compose hash it contains is included directly instead.
 */
export function teeMeasurement(m: TeeMeasured): `0x${string}` {
  return keccak256(
    concatHex(
      [m.mrTd, m.rtMr0, m.rtMr1, m.rtMr2, m.composeHash].map(
        (part) => `0x${stripHexPrefix(part).toLowerCase()}` as const,
      ),
    ),
  );
}

export const isTeeMeasurement = (value: string): boolean =>
  value !== ZERO_BYTES32 && /^0x[0-9a-fA-F]{64}$/.test(value);
