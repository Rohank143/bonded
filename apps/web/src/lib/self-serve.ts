import { mandateHash, selfServeMessage } from "@bonded/shared";
import type { Hex } from "viem";
import { deployment } from "../config";
import { api } from "./api";
import type { OnboardedAgent } from "./onboarding";

/** Signs a message with the connected wallet (wagmi's signMessageAsync). */
export type Signer = (args: { message: string }) => Promise<Hex>;

const now = () => Math.floor(Date.now() / 1000);

/** Register an agent for self-serve ratings: the owner signs the vault, design and mandate. */
export async function registerForRatings(sign: Signer, agentId: string, agent: OnboardedAgent) {
  const timestamp = now();
  const signature = await sign({
    message: selfServeMessage({
      action: "register",
      chainId: deployment.chainId,
      agentId,
      vault: agent.vault,
      kind: agent.kind,
      mandateHash: mandateHash(agent.mandate),
      timestamp,
    }),
  });
  return api.registerSelfAgent({
    agentId,
    vault: agent.vault,
    kind: agent.kind,
    mandate: agent.mandate,
    timestamp,
    signature,
  });
}

/** Ask for a rating of a self-serve agent, signed by its owner. Returns the rating's run id. */
export async function requestRating(sign: Signer, agentId: string) {
  const timestamp = now();
  const signature = await sign({
    message: selfServeMessage({ action: "rate", chainId: deployment.chainId, agentId, timestamp }),
  });
  return api.rateSelfAgent(agentId, { timestamp, signature });
}
