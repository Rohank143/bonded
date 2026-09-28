import { formatUnits, parseUnits } from "viem";
import { tierForScore } from "@bonded/shared";
import { USD_DECIMALS, explorerUrl } from "../config";

/** Format a 6-decimal base-asset amount as dollars, e.g. 1234567890n → "1,234.57". */
export function usd(amount: bigint, maxFractionDigits = 2): string {
  const [whole = "0", fraction = ""] = formatUnits(amount, USD_DECIMALS).split(".");
  const negative = whole.startsWith("-");
  const digits = negative ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = fraction.padEnd(maxFractionDigits, "0").slice(0, maxFractionDigits);
  return `${negative ? "-" : ""}${grouped}${maxFractionDigits > 0 ? `.${cents}` : ""}`;
}

/**
 * Parse a dollar amount typed by a user into 6-decimal base units. Returns null for anything
 * that is not a positive number with at most 6 decimals, so a form can refuse it.
 */
export function parseUsd(input: string): bigint | null {
  const value = input.trim().replaceAll(",", "");
  if (!/^\d+(\.\d{1,6})?$/.test(value)) return null;
  const amount = parseUnits(value, USD_DECIMALS);
  return amount > 0n ? amount : null;
}

/** Basis points as a percentage, e.g. 434 → "4.34%". */
export function bps(value: number | bigint): string {
  return `${(Number(value) / 100).toFixed(2)}%`;
}

/** 0x1234…abcd */
export function short(value: string, chars = 4): string {
  return value.length <= 2 + chars * 2
    ? value
    : `${value.slice(0, 2 + chars)}…${value.slice(-chars)}`;
}

export const txUrl = (hash: string) => `${explorerUrl}/tx/${hash}`;
export const addressUrl = (address: string) => `${explorerUrl}/address/${address}`;

/** Unix seconds as a local date and time; 0 means "never". */
export function when(seconds: number | bigint): string {
  const s = Number(seconds);
  return s === 0 ? "never" : new Date(s * 1000).toLocaleString();
}

/** Tier letter for a registry score, or "unrated" when the agent has no score yet. */
export function tierOf(score: number, issuedAt: number | bigint): string {
  return Number(issuedAt) === 0 ? "unrated" : tierForScore(score).tier;
}

export const BREACH_TYPES = [
  "T1 unauthorized target",
  "T1 unauthorized approval",
  "T1 unauthorized transfer",
  "T1 unexplained outflow",
  "T2 limit",
  "T3 asset",
] as const;

export const POLICY_STATUS = [
  "none",
  "active",
  "cancelled",
  "expired",
  "lapsed",
  "exhausted",
] as const;
