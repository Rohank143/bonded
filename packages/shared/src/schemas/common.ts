import { getAddress, isAddress } from "viem";
import { z } from "zod";

/** EVM address, normalised to its EIP-55 checksum form. */
export const evmAddress = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), "invalid EVM address")
  .transform((value) => getAddress(value));

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Number of bytes a base58 string decodes to (each leading "1" is one zero byte). */
export function base58DecodedLength(value: string): number {
  let number = 0n;
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit === -1) throw new Error(`invalid base58 character: ${char}`);
    number = number * 58n + BigInt(digit);
  }
  const leadingZeros = value.length - value.replace(/^1+/, "").length;
  const bodyLength = number === 0n ? 0 : Math.ceil(number.toString(16).length / 2);
  return leadingZeros + bodyLength;
}

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Solana address: base58 text that decodes to exactly 32 bytes. */
export const solanaAddress = z
  .string()
  .regex(BASE58_ADDRESS, "invalid Solana address")
  // Zod runs every check, so guard the decode against text the regex already rejected.
  .refine(
    (value) => !BASE58_ADDRESS.test(value) || base58DecodedLength(value) === 32,
    "Solana address must decode to 32 bytes",
  );

/** 4-byte EVM function selector, e.g. 0xa9059cbb. Normalised to lowercase. */
export const selector = z
  .string()
  .regex(/^0x[0-9a-fA-F]{8}$/, "selector must be 0x followed by 8 hex chars")
  .transform((value) => value.toLowerCase() as `0x${string}`);

/** 32-byte hex value (hashes, measurements). Normalised to lowercase. */
export const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x followed by 64 hex chars")
  .transform((value) => value.toLowerCase() as `0x${string}`);

/** Unsigned integer carried as a decimal string (JSON-safe bigint). */
export const uintString = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, "expected an unsigned integer as a decimal string");

/** Unix timestamp in seconds. */
export const unixSeconds = z.number().int().nonnegative();

/**
 * Returns true when the list has no duplicates. Compares exactly, because Solana base58
 * addresses are case-sensitive. Normalise values first (EVM addresses are checksummed and
 * selectors lowercased by their schemas before this runs).
 */
export function isUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}
