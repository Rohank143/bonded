import { parseBountySpec, type AttackSpec } from "@bonded/shared";
import { bytesToHex, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

/** BountyBoard's specURI for an attack's YAML: its sha256, as the API checks it. */
export async function specUriOf(yaml: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(yaml));
  return `sha256:${bytesToHex(new Uint8Array(digest)).slice(2)}`;
}

/** BountyBoard.commitmentFor, computed locally: keccak256(abi.encode(hunter, specURI, salt)). */
export function commitmentOf(hunter: Address, specUri: string, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "string" }, { type: "bytes32" }],
      [hunter, specUri, salt],
    ),
  );
}

/** A salt is 32 bytes: 0x and 64 hex digits. */
export const isSalt = (salt: string): salt is Hex => /^0x[0-9a-fA-F]{64}$/.test(salt);

/** The commitment, or undefined while any input is missing or the salt is half-typed. */
export function commitmentIfReady(
  hunter: Address | undefined,
  specUri: string | undefined,
  salt: string,
): Hex | undefined {
  return hunter && specUri && isSalt(salt) ? commitmentOf(hunter, specUri, salt) : undefined;
}

/** A random 32-byte salt. */
export function newSalt(): Hex {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** BountyBoard.Status, in order. */
export const BOUNTY_STATUS = ["None", "Committed", "Revealed", "Accepted", "Rejected"] as const;

/**
 * The API's own spec check, run before committing: once committed a spec can't change, so a spec
 * the API would refuse is caught while it can still be fixed. Undefined while the box is empty.
 */
export function checkSpec(yaml: string): { spec: AttackSpec } | { error: string } | undefined {
  if (!yaml.trim()) return undefined;
  try {
    return { spec: parseBountySpec(yaml) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
