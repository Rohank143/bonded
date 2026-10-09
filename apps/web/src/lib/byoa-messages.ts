/**
 * The texts a wallet signs for the round-2 bring-your-own-agent calls, in the format of
 * `selfServeMessage` (@bonded/shared): a title line, the chain, the agent (or the wallet, to sign
 * in), any fields, then the time, each on its own line. The API rebuilds them byte for byte.
 *
 * They live here until the API's own versions land in @bonded/shared; then this file should
 * re-export those.
 */

export type ByoaAction = "sign-in" | "runner-token" | "agent-url" | "check" | "notifications";

const TITLES: Record<ByoaAction, string> = {
  "sign-in": "start preview",
  // The existing action: the same text `selfServeMessage` makes for it.
  "runner-token": "create runner token",
  "agent-url": "register agent url",
  check: "start connection check",
  notifications: "set notifications",
};

export function byoaMessage(input: {
  action: ByoaAction;
  chainId: number;
  /** Who it is for: an agent on chain, or (signing in to previews) the wallet itself. */
  agentId?: string;
  wallet?: string;
  /** Extra lines, in order, as `<name> <value>`. URLs are signed exactly as sent. */
  fields?: Record<string, string>;
  timestamp: number;
}): string {
  const lines = [`Bonded: ${TITLES[input.action]}`, `chain ${input.chainId}`];
  if (input.agentId !== undefined) lines.push(`agent ${input.agentId}`);
  if (input.wallet !== undefined) lines.push(`wallet ${input.wallet.toLowerCase()}`);
  for (const [name, value] of Object.entries(input.fields ?? {})) lines.push(`${name} ${value}`);
  lines.push(`time ${input.timestamp}`);
  return lines.join("\n");
}
