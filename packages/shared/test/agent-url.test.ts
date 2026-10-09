import { createHmac } from "node:crypto";
import { keccak256, stringToBytes } from "viem";
import { describe, expect, it } from "vitest";
import {
  AGENT_URL_SIGNATURE_HEADER,
  AGENT_URL_TIMESTAMP_HEADER,
  agentUrlCodeHash,
  agentUrlSignature,
  agentUrlVerifyProof,
  answerAgentUrlVerify,
  checkAgentUrlVerifyProof,
  AgentUrlReplayGuard,
  codeHashOf,
  type EpisodeMessage,
  isWellFormedAgentSecret,
  newAgentSecret,
  parseRunnerMessage,
  RunnerToServer,
  signAgentUrlRequest,
  verifyAgentUrlRequest,
} from "../src/index.js";

const SECRET = "bonded_as_test-secret-0123456789abcdef";
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

const episode: EpisodeMessage = {
  type: "episode",
  episodeId: "ep-1",
  task: { goal: "Buy 2000 tUSDG worth of tNVDA — ünïcode.", mandate: "Trade.", maxSteps: 20 },
  mode: "tools",
  endpoints: {
    mcp: "https://gw.example/e/abc/mcp",
    tools: "https://gw.example/e/abc/tools",
    openapi: "https://gw.example/e/abc/openapi.json",
    done: "https://gw.example/e/abc/done",
  },
  chainId: 31337,
  vault: "0x000000000000000000000000000000000000dEaD",
  contracts: { exchange: "0x000000000000000000000000000000000000bEEF", tokens: [] },
  deadlineMs: 90_000,
};
const body = JSON.stringify(episode);

describe("Agent URL signatures", () => {
  it("makes well-formed secrets", () => {
    const secret = newAgentSecret();
    expect(isWellFormedAgentSecret(secret)).toBe(true);
    expect(secret).not.toBe(newAgentSecret());
    expect(isWellFormedAgentSecret("bonded_rt_abcdefghijklmnopqrstu")).toBe(false);
  });

  it("signs v1=HMAC-SHA256(secret, '<ts>.<body>'), the same as any HMAC library", async () => {
    const headers = await signAgentUrlRequest(SECRET, body, NOW);
    const ts = Math.floor(NOW / 1000);
    expect(headers[AGENT_URL_TIMESTAMP_HEADER]).toBe(String(ts));
    const expected = createHmac("sha256", SECRET).update(`${ts}.${body}`, "utf8").digest("hex");
    expect(headers[AGENT_URL_SIGNATURE_HEADER]).toBe(`v1=${expected}`);
    expect(await agentUrlSignature(SECRET, ts, new TextEncoder().encode(body))).toBe(
      `v1=${expected}`,
    );
  });

  it("round-trips: a signed episode verifies and parses", async () => {
    const headers = await signAgentUrlRequest(SECRET, body, NOW);
    const result = await verifyAgentUrlRequest({ secret: SECRET, body, headers, nowMs: NOW });
    expect(result).toMatchObject({ ok: true, message: { type: "episode", episodeId: "ep-1" } });
    // Node's IncomingMessage headers, Fetch Headers, and mixed case all work.
    const fetchHeaders = new Headers(headers);
    expect(
      (await verifyAgentUrlRequest({ secret: SECRET, body, headers: fetchHeaders, nowMs: NOW })).ok,
    ).toBe(true);
    const upper = {
      "Bonded-Timestamp": headers[AGENT_URL_TIMESTAMP_HEADER],
      "Bonded-Signature": headers[AGENT_URL_SIGNATURE_HEADER],
    };
    expect(
      (await verifyAgentUrlRequest({ secret: SECRET, body, headers: upper, nowMs: NOW })).ok,
    ).toBe(true);
  });

  it("refuses a wrong secret, a changed body, a missing or malformed signature", async () => {
    const headers = await signAgentUrlRequest(SECRET, body, NOW);
    const check = (fields: Partial<Parameters<typeof verifyAgentUrlRequest>[0]>) =>
      verifyAgentUrlRequest({ secret: SECRET, body, headers, nowMs: NOW, ...fields });
    expect(await check({ secret: "bonded_as_another-secret-0000000000" })).toMatchObject({
      ok: false,
      status: 401,
      reason: "the signature doesn't match",
    });
    expect(await check({ body: body.replace("2000", "9000") })).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(await check({ headers: {} })).toMatchObject({ reason: "the call is not signed" });
    expect(
      await check({ headers: { ...headers, [AGENT_URL_SIGNATURE_HEADER]: "v0=abcd" } }),
    ).toMatchObject({ reason: "no v1 signature" });
    expect(
      await check({ headers: { ...headers, [AGENT_URL_TIMESTAMP_HEADER]: "yesterday" } }),
    ).toMatchObject({ status: 401 });
  });

  it("refuses a stale or future timestamp, even with a valid signature", async () => {
    const old = await signAgentUrlRequest(SECRET, body, NOW - 301_000);
    expect(
      await verifyAgentUrlRequest({ secret: SECRET, body, headers: old, nowMs: NOW }),
    ).toMatchObject({ ok: false, reason: "the timestamp is too old or in the future" });
    const future = await signAgentUrlRequest(SECRET, body, NOW + 301_000);
    expect(
      (await verifyAgentUrlRequest({ secret: SECRET, body, headers: future, nowMs: NOW })).ok,
    ).toBe(false);
    const recent = await signAgentUrlRequest(SECRET, body, NOW - 299_000);
    expect(
      (await verifyAgentUrlRequest({ secret: SECRET, body, headers: recent, nowMs: NOW })).ok,
    ).toBe(true);
  });

  it("refuses a replay with a guard", async () => {
    const replay = new AgentUrlReplayGuard();
    const headers = await signAgentUrlRequest(SECRET, body, NOW);
    const once = { secret: SECRET, body, headers, nowMs: NOW, replay };
    expect((await verifyAgentUrlRequest(once)).ok).toBe(true);
    expect(await verifyAgentUrlRequest(once)).toMatchObject({
      ok: false,
      reason: "this call was already received (a replay)",
    });
    // A new call (another timestamp) passes.
    const next = await signAgentUrlRequest(SECRET, body, NOW + 1_000);
    expect((await verifyAgentUrlRequest({ ...once, headers: next, nowMs: NOW + 1_000 })).ok).toBe(
      true,
    );
  });

  it("forgets signatures once they are too old to be accepted anyway", () => {
    const guard = new AgentUrlReplayGuard(300, 3);
    expect(guard.accept("a", 1_000, 1_000)).toBe(true);
    expect(guard.accept("a", 1_000, 1_000)).toBe(false);
    // 301 s later "a" is outside the window: it is evicted (and its timestamp would be refused).
    expect(guard.accept("b", 1_301, 1_301)).toBe(true);
    expect(guard.accept("a", 1_000, 1_301)).toBe(true);
  });

  it("accepts any of several signatures or secrets while one rotates", async () => {
    const ts = Math.floor(NOW / 1000);
    const other = await agentUrlSignature("bonded_as_old-secret-00000000000000", ts, body);
    const mine = await agentUrlSignature(SECRET, ts, body);
    const headers = {
      [AGENT_URL_TIMESTAMP_HEADER]: String(ts),
      [AGENT_URL_SIGNATURE_HEADER]: `${other}, ${mine}`,
    };
    expect((await verifyAgentUrlRequest({ secret: SECRET, body, headers, nowMs: NOW })).ok).toBe(
      true,
    );
    expect(
      (
        await verifyAgentUrlRequest({
          secret: ["bonded_as_new-secret-00000000000000", SECRET],
          body,
          headers: await signAgentUrlRequest(SECRET, body, NOW),
          nowMs: NOW,
        })
      ).ok,
    ).toBe(true);
  });

  it("refuses more than four signatures in one header", async () => {
    const headers = await signAgentUrlRequest(SECRET, body, NOW);
    const sig = headers[AGENT_URL_SIGNATURE_HEADER]!;
    const pad = `v1=${"0".repeat(64)}`;
    const many = (n: number) => ({
      ...headers,
      [AGENT_URL_SIGNATURE_HEADER]: [...Array(n - 1).fill(pad), sig].join(","),
    });
    expect(
      (await verifyAgentUrlRequest({ secret: SECRET, body, headers: many(4), nowMs: NOW })).ok,
    ).toBe(true);
    expect(
      await verifyAgentUrlRequest({ secret: SECRET, body, headers: many(5), nowMs: NOW }),
    ).toMatchObject({ ok: false, reason: "too many signatures" });
  });

  it("parses verify and cancel, and refuses a signed body that isn't a Bonded message", async () => {
    for (const message of [
      { type: "verify", challenge: "c".repeat(32) },
      { type: "cancel", episodeId: "ep-1" },
    ]) {
      const text = JSON.stringify(message);
      const headers = await signAgentUrlRequest(SECRET, text, NOW);
      expect(
        await verifyAgentUrlRequest({ secret: SECRET, body: text, headers, nowMs: NOW }),
      ).toMatchObject({ ok: true, message });
    }
    for (const text of ["not json", JSON.stringify({ type: "transfer", to: "0x1" })]) {
      const headers = await signAgentUrlRequest(SECRET, text, NOW);
      expect(
        await verifyAgentUrlRequest({ secret: SECRET, body: text, headers, nowMs: NOW }),
      ).toMatchObject({ ok: false, status: 400 });
    }
  });
});

describe("the verify proof", () => {
  it("is hex HMAC-SHA256(secret, 'verify.' + challenge), and only the secret's holder can make it", async () => {
    const challenge = "c".repeat(32);
    const expected = createHmac("sha256", SECRET).update(`verify.${challenge}`).digest("hex");
    expect(await agentUrlVerifyProof(SECRET, challenge)).toBe(expected);
    const answer = await answerAgentUrlVerify(SECRET, { type: "verify", challenge }, "v3");
    expect(answer).toEqual({ challenge, proof: expected, version: "v3" });
    expect(await checkAgentUrlVerifyProof(SECRET, challenge, answer)).toBe(true);
    expect(
      await checkAgentUrlVerifyProof(SECRET, challenge, {
        ...answer,
        proof: expected.toUpperCase(),
      }),
    ).toBe(true);
    // An echo of the challenge, a proof made with another secret or for another challenge: refused.
    expect(await checkAgentUrlVerifyProof(SECRET, challenge, { challenge, proof: "" })).toBe(false);
    const other = await agentUrlVerifyProof("bonded_as_another-secret-0000000000", challenge);
    expect(await checkAgentUrlVerifyProof(SECRET, challenge, { challenge, proof: other })).toBe(
      false,
    );
    expect(await checkAgentUrlVerifyProof(SECRET, "d".repeat(32), answer)).toBe(false);
  });
});

describe("code hashes", () => {
  it("is keccak256 of '<source>:<value>'", () => {
    expect(codeHashOf("git", "abc")).toBe(keccak256(stringToBytes("git:abc")));
    expect(agentUrlCodeHash("v1.2.3")).toBe(keccak256(stringToBytes("url:v1.2.3")));
  });

  it("hello carries an optional code hash and source; older runners' hello still parses", () => {
    const hello = { type: "hello", runnerVersion: "1", protocol: 1, mode: "tools" };
    expect(parseRunnerMessage(RunnerToServer, JSON.stringify(hello))).toEqual(hello);
    const withCode = {
      ...hello,
      codeHash: `0x${"ab".repeat(32)}`,
      codeSource: "git-dirty",
      codeDetail: "a".repeat(40),
    };
    expect(parseRunnerMessage(RunnerToServer, JSON.stringify(withCode))).toEqual(withCode);
    expect(
      parseRunnerMessage(RunnerToServer, JSON.stringify({ ...hello, codeHash: "0x12" })),
    ).toBeUndefined();
    expect(
      parseRunnerMessage(
        RunnerToServer,
        JSON.stringify({ ...withCode, codeDetail: "x".repeat(201) }),
      ),
    ).toBeUndefined();
    expect(
      parseRunnerMessage(RunnerToServer, JSON.stringify({ ...withCode, codeSource: "magic" })),
    ).toBeUndefined();
  });
});
