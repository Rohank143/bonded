import { REMOTE_KIND, mandateHash, selfServeMessage } from "@bonded/shared";
import type { Hex } from "viem";
import { deployment } from "../config";
import { api } from "./api";
import type { OnboardedAgent } from "./onboarding";

/** Signs a message with the connected wallet (wagmi's signMessageAsync). */
export type Signer = (args: { message: string }) => Promise<Hex>;

const now = () => Math.floor(Date.now() / 1000);

/**
 * Register an agent for self-serve ratings: the owner signs the vault, design and mandate, and for
 * their own agent its declared code hash, mode and TEE.
 */
export async function registerForRatings(sign: Signer, agentId: string, agent: OnboardedAgent) {
  const timestamp = now();
  const base = {
    action: "register" as const,
    chainId: deployment.chainId,
    agentId,
    vault: agent.vault,
    mandateHash: mandateHash(agent.mandate),
    ...(agent.protection === "module" ? { protection: "module" as const } : {}),
    timestamp,
  };
  const protection = agent.protection === "module" ? { protection: "module" as const } : {};
  if (agent.kind === REMOTE_KIND) {
    if (!agent.remote) throw new Error("your agent's code hash and mode are missing");
    const remote = agent.remote;
    const signature = await sign({
      message: selfServeMessage({ ...base, kind: REMOTE_KIND, remote }),
    });
    return api.registerSelfAgent({
      agentId,
      vault: agent.vault,
      kind: REMOTE_KIND,
      mandate: agent.mandate,
      codeHash: remote.codeHash,
      mode: remote.mode,
      ...(remote.tee ? { tee: remote.tee } : {}),
      ...protection,
      timestamp,
      signature,
    });
  }
  const signature = await sign({
    message: selfServeMessage({
      ...base,
      kind: agent.kind,
      ...(agent.sentinel ? { sentinel: true } : {}),
    }),
  });
  return api.registerSelfAgent({
    agentId,
    vault: agent.vault,
    kind: agent.kind,
    mandate: agent.mandate,
    ...(agent.sentinel ? { sentinel: true } : {}),
    ...protection,
    timestamp,
    signature,
  });
}

/** Create a runner token for the owner's own agent, signed by the owner. Shown once. */
export async function createRunnerToken(sign: Signer, agentId: string) {
  const timestamp = now();
  const signature = await sign({
    message: selfServeMessage({
      action: "runner-token",
      chainId: deployment.chainId,
      agentId,
      timestamp,
    }),
  });
  return api.createRunnerToken(agentId, { timestamp, signature });
}

/** Revoke the agent's runner token, signed by the owner. */
export async function revokeRunnerToken(sign: Signer, agentId: string) {
  const timestamp = now();
  const signature = await sign({
    message: selfServeMessage({
      action: "revoke-runner-token",
      chainId: deployment.chainId,
      agentId,
      timestamp,
    }),
  });
  return api.revokeRunnerToken(agentId, { timestamp, signature });
}

/** Ask for a rating of a self-serve agent, signed by its owner. Returns the rating's run id. */
export async function requestRating(sign: Signer, agentId: string) {
  const timestamp = now();
  const signature = await sign({
    message: selfServeMessage({ action: "rate", chainId: deployment.chainId, agentId, timestamp }),
  });
  return api.rateSelfAgent(agentId, { timestamp, signature });
}
