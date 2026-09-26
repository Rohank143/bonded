import { keccak256, stringToBytes } from "viem";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Deterministic JSON: object keys sorted, no whitespace, arrays kept in order.
 * Only integers are allowed as numbers so the output never depends on float formatting.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value));
}

/** keccak256 of the canonical JSON encoding. */
export function canonicalHash(value: unknown): `0x${string}` {
  return keccak256(stringToBytes(canonicalJson(value)));
}

function normalise(value: unknown): Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`canonicalJson: only safe integers are allowed, got ${value}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalise);
  }
  if (typeof value === "object") {
    // Only plain objects: a Date, Map or class instance would silently encode as {}.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error("canonicalJson: only plain objects are allowed");
    }
    // Null prototype so an own "__proto__" key is kept as data instead of changing the prototype.
    const sorted = Object.create(null) as { [key: string]: Json };
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) {
        sorted[key] = normalise(entry);
      }
    }
    return sorted;
  }
  throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
}
