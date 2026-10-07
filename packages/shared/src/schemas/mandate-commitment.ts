import { encodeAbiParameters, keccak256, zeroHash } from "viem";
import type { EvmMandateParams } from "./mandate.js";

/** ABI type of the Solidity struct `BondedTypes.MandateParams`. */
const MANDATE_PARAMS_ABI = [
  {
    type: "tuple",
    components: [
      { name: "mandateHash", type: "bytes32" },
      { name: "mode", type: "uint8" },
      { name: "baseAsset", type: "address" },
      { name: "assets", type: "address[]" },
      { name: "targets", type: "address[]" },
      { name: "selectors", type: "bytes4[][]" },
      { name: "destinations", type: "address[]" },
      { name: "maxTxNotionalUsd6", type: "uint256" },
      { name: "maxDailyNotionalUsd6", type: "uint256" },
      { name: "maxDrawdownBps", type: "uint16" },
      { name: "maxSlippageBps", type: "uint16" },
      { name: "freezeOnBreach", type: "bool" },
    ],
  },
] as const;

/**
 * On-chain commitment to the rules a mandate enforces: keccak256 of the ABI-encoded params with
 * `mandateHash` set to zero. Matches `BondedTypes.mandateCommitment` in Solidity.
 *
 * MandateModuleFactory refuses a module whose `mandateHash` isn't this value, so a module's
 * mandate hash proves what it enforces. Ratings, quotes and cover for a module-protected agent
 * use this commitment as the mandate hash (vaults still use the hash of the mandate JSON).
 */
export function mandateCommitment(params: EvmMandateParams): `0x${string}` {
  return keccak256(encodeAbiParameters(MANDATE_PARAMS_ABI, [{ ...params, mandateHash: zeroHash }]));
}

/** The params with `mandateHash` replaced by their commitment, ready for `createModule`. */
export function withMandateCommitment(params: EvmMandateParams): EvmMandateParams {
  return { ...params, mandateHash: mandateCommitment(params) };
}
