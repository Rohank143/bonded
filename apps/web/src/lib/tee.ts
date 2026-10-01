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
