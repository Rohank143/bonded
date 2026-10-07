import { mandateVaultAbi } from "@bonded/shared";
import { type Address, decodeErrorResult, type Hex, isHex } from "viem";
import { BondedError, CallRevertedError, NotAgentError, VaultFrozenError } from "./errors.js";

interface Revert {
  errorName?: string | undefined;
  reason?: string | undefined;
  raw?: Hex | undefined;
  signature?: Hex | undefined;
}

/**
 * Turns a reverted `execute` into the SDK's typed errors: the vault's own errors (wrong key,
 * frozen, calling itself) by name, anything else as the target call failing. Other errors
 * (network, nonce) are returned unchanged.
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
  }
  const why = revert.reason ?? revert.errorName ?? revert.signature;
  return new CallRevertedError(
    `the vault's call to ${context.target} reverted${why ? `: ${why}` : ""}; nothing changed`,
    revert.raw,
    { cause: error },
  );
}

/** Errors are matched by name, not instanceof: clients may come from another copy of viem. */
function findRevert(error: unknown): Revert | undefined {
  const chain: Error[] = [];
  for (let e = error, depth = 0; e instanceof Error && depth < 20; e = e.cause, depth++)
    chain.push(e);
  for (const e of chain) {
    if (e.name !== "ContractFunctionRevertedError") continue;
    const r = e as Error & Revert & { data?: { errorName?: string } };
    return { errorName: r.data?.errorName, reason: r.reason, raw: r.raw, signature: r.signature };
  }
  // Decoded without the vault's ABI (e.g. by another library estimating gas): the revert data
  // sits on a lower error.
  for (const e of chain) {
    const data = (e as { data?: unknown }).data;
    if (typeof data !== "string" || !isHex(data) || data.length < 10) continue;
    try {
      // viem also decodes the built-in Error(string) and Panic(uint256).
      const decoded = decodeErrorResult({ abi: mandateVaultAbi, data }) as {
        errorName: string;
        args?: readonly unknown[];
      };
      const reason = decoded.errorName === "Error" ? String(decoded.args?.[0]) : undefined;
      return { errorName: decoded.errorName, reason, raw: data };
    } catch {
      return { raw: data, signature: data.slice(0, 10) as Hex };
    }
  }
  return undefined;
}
