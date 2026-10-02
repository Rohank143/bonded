import { isTeeMeasurement } from "@bonded/shared";
import type { Report } from "./api";

export interface TeeView {
  /** The registry holds a TEE measurement for this agent's current score. */
  inTee: boolean;
  /** The on-chain measurement. */
  measurement: `0x${string}` | null;
  /** The session keys from the report, shown only when the report is the one that was posted. */
  keys: { evm: string; solana: string } | null;
}

/**
 * What the profile says about custody. The registry is the authority: the badge shows only when
 * the on-chain measurement is set. The report supplies the keys, and only when its measurement is
 * the very one on-chain, so the page never shows keys from a different rating.
 */
export function teeView(onchain: string | undefined, report: Report | null | undefined): TeeView {
  if (!onchain || !isTeeMeasurement(onchain))
    return { inTee: false, measurement: null, keys: null };
  const tee = report?.tee;
  const matches = tee && tee.measurement.toLowerCase() === onchain.toLowerCase();
  return {
    inTee: true,
    measurement: onchain as `0x${string}`,
    keys: matches ? { evm: tee.evmAddress, solana: tee.solanaPublicKey } : null,
  };
}

export interface LiveCheckView {
  label: string;
  tone: "safe" | "breach" | "neutral";
  hint: string;
}

/**
 * How the keeper's latest live check reads on the profile. Only a definite failure is red: an
 * unreachable agent is shown as such, since a stopped VM is not a broken one.
 */
export function liveCheckView(status: string | undefined): LiveCheckView {
  switch (status) {
    case "verified":
      return { label: "verified", tone: "safe", hint: "the running TEE is the one that was rated" };
    case "mismatch":
      return {
        label: "changed",
        tone: "breach",
        hint: "the running TEE is not the one that was rated; new cover is paused until it is re-rated",
      };
    case "invalid":
      return {
        label: "failed",
        tone: "breach",
        hint: "the TEE's proof does not verify; new cover is paused until it is re-rated",
      };
    case "unreachable":
      return { label: "offline", tone: "neutral", hint: "the TEE agent did not answer" };
    case "unrated":
      return { label: "not rated", tone: "neutral", hint: "no TEE measurement in the score yet" };
    default:
      return { label: "not checked", tone: "neutral", hint: "the keeper has not checked it yet" };
  }
}
