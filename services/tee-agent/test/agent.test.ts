import { connect, type AddressInfo } from "node:net";
import { TeeEvidence, teeArenaReportData, teeReportData } from "@bonded/shared";
import { bytesToHex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { type TeeBackend, AgentIdentity, createTeeServer, MockBackend } from "../src/index.js";

const CODE = `0x${"07".repeat(32)}` as const;
const NONCE = `0x${"09".repeat(32)}`;

/** Records what it was asked to sign, and returns a recognisable fake quote. */
class RecordingBackend extends MockBackend implements TeeBackend {
  asked: Uint8Array[] = [];
  override async quote(reportData: Uint8Array) {
    this.asked.push(reportData);
    return { quote: "0xdeadbeef", eventLog: "[]" };
  }
  override async composeHash() {
    return `0x${"ab".repeat(32)}`;
  }
}

const servers: { close: () => void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function serve(backend: TeeBackend = new RecordingBackend()) {
  const identity = await AgentIdentity.create(backend, CODE);
  const server = createTeeServer(identity, backend.name);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { identity, base, backend };
}

describe("AgentIdentity", () => {
  it("derives the same keys for the same backend", async () => {
    const a = await AgentIdentity.create(new MockBackend(), CODE);
    const b = await AgentIdentity.create(new MockBackend(), CODE);
    expect(a.evmAddress).toBe(b.evmAddress);
    expect(a.solanaPublicKey).toBe(b.solanaPublicKey);
    expect(a.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("refuses a malformed code hash", async () => {
    await expect(AgentIdentity.create(new MockBackend(), "")).rejects.toThrow(/CODE_HASH/);
    await expect(AgentIdentity.create(new MockBackend(), "0x12")).rejects.toThrow(/CODE_HASH/);
  });

  it("asks the hardware to sign a commitment to its code, both keys and the nonce", async () => {
    const backend = new RecordingBackend();
    const identity = await AgentIdentity.create(backend, CODE);
    const evidence = await identity.attest(NONCE);
    expect(backend.asked).toHaveLength(1);
    expect(bytesToHex(backend.asked[0]!)).toBe(
      teeReportData({
        codeHash: CODE,
        evmAddress: identity.evmAddress,
        solanaPublicKey: identity.solanaPublicKey,
        nonce: NONCE,
      }),
    );
    // The Arena parses exactly this shape.
    expect(TeeEvidence.parse(evidence)).toMatchObject({
      codeHash: CODE,
      composeHash: "ab".repeat(32),
      quote: "0xdeadbeef",
    });
  });

  it("takes a fresh quote for each challenge", async () => {
    const backend = new RecordingBackend();
    const identity = await AgentIdentity.create(backend, CODE);
    await identity.attest(NONCE);
    await identity.attest(`0x${"0a".repeat(32)}`);
    expect(bytesToHex(backend.asked[0]!)).not.toBe(bytesToHex(backend.asked[1]!));
  });

  it("derives a separate Arena key per rating and attests it under the Arena domain", async () => {
    const backend = new RecordingBackend();
    const identity = await AgentIdentity.create(backend, CODE);
    const keyA = `0x${"aa".repeat(32)}`;
    const keyB = `0x${"bb".repeat(32)}`;
    const a = await identity.arenaAccount(keyA);
    expect((await identity.arenaAccount(keyA.toUpperCase().replace("0X", "0x"))).address).toBe(
      a.address,
    );
    expect((await identity.arenaAccount(keyB)).address).not.toBe(a.address);
    // Never the production key.
    expect(a.address).not.toBe(identity.evmAddress);
    const evidence = await identity.attestArena(NONCE, keyA);
    expect(TeeEvidence.parse(evidence)).toMatchObject({
      purpose: "arena",
      keyId: keyA,
      evmAddress: a.address,
      nonce: NONCE,
    });
    expect(evidence).not.toHaveProperty("solanaPublicKey");
    expect(bytesToHex(backend.asked.at(-1)!)).toBe(
      teeArenaReportData({ codeHash: CODE, evmAddress: a.address, keyId: keyA, nonce: NONCE }),
    );
    await expect(identity.arenaAccount("0x12")).rejects.toThrow(/32 bytes/);
  });

  it("signs with its session key", async () => {
    const identity = await AgentIdentity.create(new MockBackend(), CODE);
    expect(await identity.signMessage("hi")).toMatch(/^0x[0-9a-f]+$/);
  });
});

describe("the HTTP server", () => {
  it("serves an Arena key's evidence when asked, and refuses a bad purpose or key id", async () => {
    const { base, identity } = await serve();
    const key = `0x${"cd".repeat(32)}`;
    const response = await fetch(`${base}/attestation?nonce=${NONCE}&purpose=arena&key=${key}`);
    expect(response.status).toBe(200);
    const evidence = TeeEvidence.parse(await response.json());
    expect(evidence).toMatchObject({ purpose: "arena", keyId: key });
    expect(evidence.evmAddress).toBe((await identity.arenaAccount(key)).address);
    expect((await fetch(`${base}/attestation?nonce=${NONCE}&purpose=other`)).status).toBe(400);
    expect((await fetch(`${base}/attestation?nonce=${NONCE}&purpose=arena&key=0x12`)).status).toBe(
      400,
    );
  });

  it("serves evidence for a challenge", async () => {
    const { base, identity } = await serve();
    const response = await fetch(`${base}/attestation?nonce=${NONCE}`);
    expect(response.status).toBe(200);
    const evidence = TeeEvidence.parse(await response.json());
    expect(evidence.evmAddress).toBe(identity.evmAddress);
    expect(evidence.nonce).toBe(NONCE);
  });

  it("rejects a missing or malformed nonce", async () => {
    const { base } = await serve();
    for (const query of ["", "?nonce=", "?nonce=0x12", `?nonce=${"zz".repeat(32)}`]) {
      const response = await fetch(`${base}/attestation${query}`);
      expect(response.status).toBe(400);
    }
  });

  it("reports health, the keys' public halves and which backend it runs", async () => {
    const { base, identity } = await serve(new MockBackend());
    expect(await (await fetch(`${base}/health`)).json()).toEqual({
      ok: true,
      backend: "mock",
      codeHash: CODE,
      evmAddress: identity.evmAddress,
      solanaPublicKey: identity.solanaPublicKey,
    });
  });

  it("only answers GET on known routes", async () => {
    const { base } = await serve();
    expect((await fetch(`${base}/attestation?nonce=${NONCE}`, { method: "POST" })).status).toBe(
      405,
    );
    expect((await fetch(`${base}/sign`)).status).toBe(404);
    expect((await fetch(`${base}/key`)).status).toBe(404);
  });

  it("answers a malformed request target with 400 instead of crashing", async () => {
    const { base } = await serve();
    const { port } = new URL(base);
    // Node's parser accepts this target and `new URL` rejects it, so it used to throw in the handler.
    for (const target of ["//[", "//%", "http://[::1"]) {
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = connect(Number(port), "127.0.0.1", () =>
          socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`),
        );
        let data = "";
        socket.on("data", (chunk) => (data += chunk));
        socket.on("end", () => resolve(data));
        socket.on("error", reject);
      });
      expect(reply).toMatch(/^HTTP\/1\.1 400/);
    }
    // And the server is still up.
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("never returns a private key", async () => {
    const backend = new MockBackend();
    const { base } = await serve(backend);
    const secrets = [await backend.evmKey(), await backend.solanaSeed()].flatMap((k) => [
      Buffer.from(k).toString("hex"),
      Buffer.from(k).toString("base64"),
    ]);
    for (const path of ["/health", `/attestation?nonce=${NONCE}`]) {
      const text = await (await fetch(`${base}${path}`)).text();
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
  });

  it("answers 503 without leaking details when the hardware fails", async () => {
    class Broken extends MockBackend {
      override async quote(): Promise<never> {
        throw new Error("socket path /var/run/dstack.sock refused");
      }
    }
    const { base } = await serve(new Broken());
    const response = await fetch(`${base}/attestation?nonce=${NONCE}`);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("dstack.sock");
  });
});
