import { mandateModuleAbi, mandateVaultAbi } from "@bondedhq/shared";
import { type Address, decodeErrorResult, type Hex, isHex, parseAbi } from "viem";
import { BondedError, CallRevertedError, NotAgentError, VaultFrozenError } from "./errors.js";

/**
 * Every error `execute` can revert with: the vault's and the module's own, and the error an
 * ERC-7579 account (Safe7579, the reference account) raises when the module's call fails.
 */
const REVERT_ABI = [
  ...mandateVaultAbi.filter((item) => item.type === "error"),
  ...mandateModuleAbi.filter((item) => item.type === "error"),
  ...parseAbi(["error ExecutionFailed()"]),
];

interface Revert {
  errorName?: string | undefined;
  reason?: string | undefined;
  raw?: Hex | undefined;
  signature?: Hex | undefined;
}

/**
 * Turns a reverted `execute` into the SDK's typed errors: the vault's or module's own errors
 * (wrong key, frozen, not installed, calling itself) by name, anything else as the target call
 * failing. Other errors (network, nonce) are returned unchanged.
 */
export function vaultRevertError(
  error: unknown,
  context: { vault: Address; target: Address; signer?: Address | undefined },
): unknown {
  const revert = findRevert(error);
  if (!revert) return error;
  switch (revert.errorName) {
    case "NotAgent":
      return new NotAgentError(context.vault, context.signer, { cause: error });
    case "AgentFrozen":
      return new VaultFrozenError(context.vault, undefined, undefined, { cause: error });
    case "CannotCallVault":
      return new BondedError("INVALID_ACTION", "the vault can't call itself", { cause: error });
    case "CannotCallAccount":
    case "CannotCallModule":
      return new BondedError(
        "INVALID_ACTION",
        "the module can't call its own account or itself (that could change the account's setup)",
        { cause: error },
      );
    case "NotInstalled":
      return new BondedError(
        "MODULE_NOT_INSTALLED",
        `module ${context.vault} isn't installed on its account; the account's owner installs it as an executor (and hook)`,
        { cause: error },
      );
    case "ExecutionFailed":
      return new CallRevertedError(
        `the account's call to ${context.target} failed (the account reports ExecutionFailed without the reason); nothing changed`,
        revert.raw,
        { cause: error },
      );
  }
  const why = revert.reason ?? revert.errorName ?? revert.signature;
  return new CallRevertedError(
    `the call to ${context.target} reverted${why ? `: ${why}` : ""}; nothing changed`,
    revert.raw,
    { cause: error },
  );
}

/** Errors are matched by name, not instanceof: clients may come from another copy of viem. */
function findRevert(error: unknown): Revert | undefined {
  const chain: Error[] = [];
  for (let e = error, depth = 0; e instanceof Error && depth < 20; e = e.cause, depth++)
    chain.push(e);
  const reverted = chain.find((e) => e.name === "ContractFunctionRevertedError") as
    (Error & Revert & { data?: { errorName?: string } }) | undefined;
  // The revert data: on viem's decoded error, or on a lower error when it was decoded without
  // the vault's ABI (e.g. by another library estimating gas).
  const raw =
    reverted?.raw ??
    (chain
      .map((e) => (e as { data?: unknown }).data)
      .find((d) => typeof d === "string" && isHex(d) && d.length >= 10) as Hex | undefined);
  if (raw && raw.length >= 10) {
    try {
      // viem also decodes the built-in Error(string) and Panic(uint256).
      const decoded = decodeErrorResult({ abi: REVERT_ABI, data: raw }) as {
        errorName: string;
        args?: readonly unknown[];
      };
      const reason = decoded.errorName === "Error" ? String(decoded.args?.[0]) : undefined;
      return { errorName: decoded.errorName, reason, raw };
    } catch {
      return { reason: reverted?.reason, raw, signature: raw.slice(0, 10) as Hex };
    }
  }
  if (reverted)
    return {
      errorName: reverted.data?.errorName,
      reason: reverted.reason,
      signature: reverted.signature,
    };
  return undefined;
}
