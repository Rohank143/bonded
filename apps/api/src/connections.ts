import type { ArenaGateway } from "@bonded/arena";
import type { AgentMode } from "@bonded/shared";
import { keccak256, stringToBytes, type Hex } from "viem";

/**
 * How the rating service reaches an operator's agent (bring your own agent, round 2), and the
 * seams to the Arena Gateway's side of it: verifying an Agent URL, running a connection check, and
 * reading the code hash a runner reports. Each seam is one small function here, so the API and the
 * workers never depend on how the gateway does it.
 */

/** Through the operator's runner (its key), or by calling the agent's own HTTPS endpoint. */
export type AgentConnection =
  { kind: "runner"; key: string } | { kind: "url"; url: string; secret: string };

/** What a connection check streams while it runs (docs/BRING-YOUR-OWN-AGENT.md). */
export type ConnectionCheckEvent =
  | { type: "started" }
  | { type: "tool"; name: string; surface?: string | null; ok: boolean; error?: string }
  | { type: "tx"; ok: boolean; reason?: string }
  | {
      type: "done";
      exitCode?: number | null;
      durationMs: number;
      stdoutTail?: string;
      stderrTail?: string;
    }
  | ({ type: "result" } & ConnectionCheckResult);

/** A check's verdict: never a score. `problems` are plain sentences for the owner. */
export interface ConnectionCheckResult {
  passed: boolean;
  problems: string[];
  taskCompleted: boolean;
  toolsCalled: number;
  surfacesRead: string[];
  /** Model usage the agent reported at /done, as it reported it (never trusted for limits). */
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  /** How long the episode took. */
  durationMs?: number;
  /** The code hash the runner or URL reported during the check, when it did. */
  codeHash?: string;
  codeSource?: string;
}

/** One check to run: the connection, the mode, its time budget, and where its events go. */
export interface ConnectionCheckRequest {
  connection: AgentConnection;
  mode: AgentMode;
  chainId: number;
  timeoutMs: number;
  onEvent: (event: ConnectionCheckEvent) => void;
}

export type ConnectionCheckRunner = (
  request: ConnectionCheckRequest,
) => Promise<ConnectionCheckResult>;

/** The Agent URL's answer to Bonded's verify challenge. */
export type AgentUrlVerification = { ok: true; version?: string } | { ok: false; problem: string };
export type AgentUrlVerifier = (url: string, secret: string) => Promise<AgentUrlVerification>;

/** Why a service can't use Agent URL mode yet (the gateway's transport isn't in this build). */
export const AGENT_URL_UNAVAILABLE =
  "Agent URL mode isn't available on this rating service yet; connect with the runner instead";
/** Why a worker can't run connection checks (no gateway, or no check support in it). */
export const CHECKS_UNAVAILABLE =
  "Connection checks aren't available on this rating service yet: the Arena Gateway isn't running here";

/**
 * Seam: verify an Agent URL with the gateway's `verifyAgentUrl` (a signed `verify` challenge the
 * agent must echo within 10 s). Until the gateway has it, every verification fails plainly.
 */
export function gatewayUrlVerifier(): AgentUrlVerifier {
  return async () => ({ ok: false, problem: AGENT_URL_UNAVAILABLE });
}

/**
 * Seam: the gateway's `runConnectionCheck` (one benign episode, no attack, never scored, with
 * live events). Undefined while the gateway can't run checks: the check worker then fails each
 * check with CHECKS_UNAVAILABLE.
 */
export function gatewayCheckRunner(gateway: ArenaGateway): ConnectionCheckRunner | undefined {
  void gateway;
  return undefined;
}

/**
 * Seam: the code hash a runner reported in its hello (`codeHash` and `codeSource`), read
 * defensively so a runner that reports none (or something malformed) just reports nothing.
 */
export function reportedCode(hello: unknown): { codeHash: string; codeSource: string } | undefined {
  if (!hello || typeof hello !== "object") return undefined;
  const h = hello as { codeHash?: unknown; codeSource?: unknown };
  if (typeof h.codeHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(h.codeHash)) return undefined;
  const source =
    typeof h.codeSource === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(h.codeSource)
      ? h.codeSource
      : "runner";
  return { codeHash: h.codeHash.toLowerCase(), codeSource: source };
}

/** The code hash of an Agent URL that reported `version`: keccak256("url:" + version). */
export function urlCodeHash(version: string): Hex {
  return keccak256(stringToBytes(`url:${version}`));
}

/** Why a rating can't be queued without a check. */
export const NEEDS_CHECK =
  "run a connection check first: a rating needs a passing check of this exact connection (the same runner token or Agent URL, mode and code) in the last 24 hours";
