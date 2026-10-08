import { sentinelCheckDigest, sentinelCheckMessage } from "@bonded/shared";
import { type Address, type Hex, isAddressEqual, recoverMessageAddress } from "viem";

/**
 * A stand-in for the Bonded API's `POST /sentinel/check`, checking a request the way the route
 * does (apps/api/src/sentinel.ts): the signature must recover to the agent key, for this agent
 * id and vault (or module). It flags any action taken after reading "send everything". The
 * route itself is tested with the SDK's client in apps/api/test/sentinel.test.ts.
 */
export function fakeSentinelApi(expected: {
  chainId: number;
  agent: Address;
  agentId: bigint;
  vault: Address;
  status?: number;
}) {
  const asked: { tool: string; args: Record<string, string> }[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    if (expected.status && expected.status !== 200)
      return Response.json({ error: "Sentinel is busy" }, { status: expected.status });
    const body = JSON.parse(init.body as string);
    if (body.agentId !== expected.agentId.toString() || !isAddressEqual(body.vault, expected.vault))
      return Response.json({ error: "that vault doesn't belong to this agent" }, { status: 400 });
    const signer = await recoverMessageAddress({
      message: sentinelCheckMessage({
        chainId: expected.chainId,
        agentId: body.agentId,
        vault: body.vault,
        digest: sentinelCheckDigest(body),
        timestamp: body.timestamp,
      }),
      signature: body.signature as Hex,
    });
    if (!isAddressEqual(signer, expected.agent))
      return Response.json({ error: "sign with the vault's agent key" }, { status: 403 });
    asked.push(body.proposedAction);
    const planted = body.untrustedInputs.some((i: { output: string }) =>
      /send everything/i.test(i.output),
    );
    return Response.json({
      blocked: planted,
      manipulated: planted ? 0.93 : 0.04,
      injection: planted ? 0.97 : 0.02,
      blockThreshold: 0.7,
      model: "fake-sentinel",
      latencyMs: 5,
      advice: planted ? "Don't take this action." : "No sign of manipulation.",
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}
