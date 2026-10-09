import { bondedRegistryAbi, operatorBondAbi } from "@bondedhq/shared";
import type { ServiceChain } from "@bonded/keeper";

/**
 * Why an operator-run agent can't be rated now, or undefined when it can: the owner who
 * registered its config must still own it (a new owner registers again, under their own config),
 * and its operator must have a bond staked (skin in the game: a rating is work done for an agent
 * that can hold cover). Read from the chain at the time of asking; used for owners' requests and
 * renewals alike.
 */
export async function remoteRatingProblem(
  chain: Pick<ServiceChain, "read" | "deployment">,
  agentId: string,
  registeredBy: string | null,
): Promise<string | undefined> {
  const d = chain.deployment;
  const [owner, bond] = await Promise.all([
    chain.read.readContract({
      address: d.registry,
      abi: bondedRegistryAbi,
      functionName: "agentOwner",
      args: [BigInt(agentId)],
    }),
    chain.read.readContract({
      address: d.bond,
      abi: operatorBondAbi,
      functionName: "bondOf",
      args: [BigInt(agentId)],
    }),
  ]);
  if (owner.toLowerCase() !== (registeredBy ?? "").toLowerCase())
    return "the agent changed hands since it was registered: re-register to rate under your own config";
  if (bond === 0n)
    return "stake an operator bond for the agent first: ratings of your own agent need one";
  return undefined;
}
