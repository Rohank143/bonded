/**
 * @bonded/sdk: trade through a Bonded Mandate Vault from any TypeScript agent.
 *
 * Framework plugins live in subpaths, each with its framework as an optional peer dependency:
 * `@bonded/sdk/agentkit`, `@bonded/sdk/solana-agent-kit`, `@bonded/sdk/eliza`.
 */
export {
  BondedVault,
  type ActionResult,
  type BondedVaultConfig,
  type VaultStatus,
} from "./vault.js";
export {
  demoRouter,
  describeAction,
  type ApproveParams,
  type CallParams,
  type SwapParams,
  type SwapRouter,
  type TransferParams,
  type VaultAction,
  type VaultCall,
} from "./actions.js";
export { breachReason, type DryRunResult, type VaultBreach } from "./breaches.js";
export {
  guarded,
  GuardedVault,
  type GuardCheck,
  type GuardContext,
  type GuardedResult,
  type GuardOptions,
  type SentinelGuardOptions,
  type TokenInfo,
} from "./guarded.js";
export {
  checkWithSentinel,
  type MessageSigner,
  type SentinelCheckRequest,
  type SentinelInput,
} from "./sentinel.js";
export {
  buildMandate,
  describeMandate,
  type BuiltMandate,
  type EvmMandate,
  type EvmMandateParams,
  type EvmMandateRules,
} from "./mandate.js";
export {
  BlockedByMandateError,
  BondedError,
  CallRevertedError,
  NotAgentError,
  PredictedBreachError,
  SentinelError,
  SentinelRefusedError,
  VaultFrozenError,
  type SentinelVerdict,
} from "./errors.js";
export type { BreachType } from "@bonded/shared";
export { bondedEpisodeEnv, fromBondedEnv, type BondedEpisode } from "./episode.js";
