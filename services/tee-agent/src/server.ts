import { createServer, type Server } from "node:http";
import type { AgentIdentity } from "./identity.js";

const NONCE = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * The agent's public face. Two read-only routes; there is no route that signs, runs or reveals a
 * key. Anyone may call `/attestation`: it holds nothing secret, and every field is checked by
 * whoever asks.
 */
export function createTeeServer(identity: AgentIdentity, backendName: string): Server {
  return createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://agent.local");
    if (req.method !== "GET") return send(405, { error: "method not allowed" });
    if (url.pathname === "/health")
      return send(200, {
        ok: true,
        backend: backendName,
        codeHash: identity.codeHash,
        evmAddress: identity.evmAddress,
        solanaPublicKey: identity.solanaPublicKey,
      });
    if (url.pathname === "/attestation") {
      const nonce = url.searchParams.get("nonce") ?? "";
      if (!NONCE.test(nonce))
        return send(400, {
          error: "nonce must be 32 bytes of hex (the caller's random challenge)",
        });
      identity.attest(nonce).then(
        (evidence) => send(200, evidence),
        () => send(503, { error: "attestation unavailable" }),
      );
      return;
    }
    send(404, { error: "not found" });
  });
}
