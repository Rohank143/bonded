import { getAddress, isAddress } from "viem";
import { z } from "zod";

/** EVM address, normalised to its EIP-55 checksum form. */
export const evmAddress = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), "invalid EVM address")
  .transform((value) => getAddress(value));

/** Solana public key (base58, 32–44 chars). */
export const solanaAddress = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "invalid Solana address");

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

/** Returns true when the list has no duplicates (case-insensitive). */
export function isUnique(values: readonly string[]): boolean {
  return new Set(values.map((value) => value.toLowerCase())).size === values.length;
}
