import {
  SENTINEL_INPUT_CHARS,
  type SentinelCheckBody,
  type SentinelInput,
  sentinelCheckDigest,
  sentinelCheckMessage,
} from "@bondedhq/shared";
import type { Address, Hex, SignableMessage } from "viem";
import { z } from "zod";
import { BondedError, SentinelError, type SentinelVerdict } from "./errors.js";

export type { SentinelInput, SentinelVerdict };

/** Signs EIP-191 messages with the vault's agent key. A viem `LocalAccount` is one. */
export interface MessageSigner {
  signMessage(args: { message: SignableMessage }): Promise<Hex>;
}

export interface SentinelCheckRequest {
  /** The Bonded API, e.g. https://api.bonded.example (no trailing path). */
  apiUrl: string;
  /** The chain the vault is on; part of the signed message. */
  chainId: number;
  /** The agent's id in the Bonded registry. */
  agentId: bigint | number | string;
  vault: Address;
  /** The mandate in plain words (`describeMandate` writes one). At most 4,000 characters. */
  mandate: string;
  /** What the agent wants to do: a tool name and its arguments as strings. */
  proposedAction: { tool: string; args: Record<string, string> };
  /** What the agent read from outside before deciding (emails, posts, tool output). At most 20. */
  untrustedInputs?: readonly SentinelInput[];
  /** The vault's agent key: the API only answers checks signed by it. */
  account: MessageSigner;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Unix seconds to sign; defaults to now. The API accepts a check for 120 seconds. */
  timestamp?: number;
}

const verdictSchema = z.object({
  blocked: z.boolean(),
  manipulated: z.number(),
  injection: z.number(),
  blockThreshold: z.number(),
  model: z.string(),
  latencyMs: z.number(),
  advice: z.string(),
});

/** The API's limits on a check (apps/api/src/sentinel.ts), checked here for clearer errors. */
const LIMITS = { mandate: 4_000, tool: 64, args: 20, argKey: 64, argValue: 2_000, inputs: 20 };

/**
 * Asks Bonded Sentinel whether a proposed action looks driven by what the agent read rather
 * than by its mandate. Signs the request with the agent key, as the API requires.
 *
 * Advisory only: the vault's breach log, not Sentinel, decides claims and ratings. Throws
 * `SentinelError` when the API refuses or can't answer (it returns 503 while Sentinel is down).
 */
export async function checkWithSentinel(request: SentinelCheckRequest): Promise<SentinelVerdict> {
  const body: SentinelCheckBody = {
    mandate: request.mandate,
    proposedAction: request.proposedAction,
    // Sentinel only sees the first SENTINEL_INPUT_CHARS of each input; the API rejects more.
    untrustedInputs: (request.untrustedInputs ?? []).map((input) => ({
      tool: input.tool,
      output: input.output.slice(0, SENTINEL_INPUT_CHARS),
    })),
  };
  checkLimits(body);
  const agentId = request.agentId.toString();
  const timestamp = request.timestamp ?? Math.floor(Date.now() / 1000);
  const signature = await request.account.signMessage({
    message: sentinelCheckMessage({
      chainId: request.chainId,
      agentId,
      vault: request.vault,
      digest: sentinelCheckDigest(body),
      timestamp,
    }),
  });

  const url = `${request.apiUrl.replace(/\/+$/, "")}/sentinel/check`;
  let response: Response;
  try {
    response = await (request.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId, vault: request.vault, timestamp, signature, ...body }),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (error) {
    throw new SentinelError(`couldn't reach ${url}: ${(error as Error).message}`, undefined, {
      cause: error,
    });
  }
  const json: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      json && typeof json === "object" && "error" in json && typeof json.error === "string"
        ? json.error
        : response.statusText || "no reason given";
    throw new SentinelError(
      `Sentinel check refused (${response.status}): ${message}`,
      response.status,
    );
  }
  const verdict = verdictSchema.safeParse(json);
  if (!verdict.success)
    throw new SentinelError(`unexpected answer from ${url}`, response.status, {
      cause: verdict.error,
    });
  return verdict.data;
}

function checkLimits(body: SentinelCheckBody): void {
  const fail = (what: string) => {
    throw new BondedError("SENTINEL_REQUEST_TOO_LARGE", `Sentinel check: ${what}`);
  };
  if (body.mandate.length === 0 || body.mandate.length > LIMITS.mandate)
    fail(`the mandate must be 1 to ${LIMITS.mandate} characters`);
  const { tool, args } = body.proposedAction;
  if (tool.length === 0 || tool.length > LIMITS.tool)
    fail(`the tool name must be 1 to ${LIMITS.tool} characters`);
  const entries = Object.entries(args);
  if (entries.length > LIMITS.args) fail(`at most ${LIMITS.args} arguments`);
  for (const [key, value] of entries)
    if (key.length > LIMITS.argKey || value.length > LIMITS.argValue)
      fail(`argument ${key.slice(0, 20)} is too long`);
  if (body.untrustedInputs.length > LIMITS.inputs)
    fail(`at most ${LIMITS.inputs} untrusted inputs; send the ones read for this action`);
  for (const input of body.untrustedInputs)
    if (input.tool.length === 0 || input.tool.length > LIMITS.tool)
      fail(`each input's tool name must be 1 to ${LIMITS.tool} characters`);
}
