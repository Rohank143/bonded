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

/** A random 32-byte salt. */
export function newSalt(): Hex {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** BountyBoard.Status, in order. */
export const BOUNTY_STATUS = ["None", "Committed", "Revealed", "Accepted", "Rejected"] as const;
