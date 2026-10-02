import { createServer, type Server } from "node:http";
import type { AgentIdentity } from "./identity.js";

const NONCE = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * The agent's public face. Two read-only routes; there is no route that signs, runs or reveals a
 * key. Anyone may call `/attestation`: it holds nothing secret, and every field is checked by
 * whoever asks.
 */
export function createTeeServer(identity: AgentIdentity, backendName: string): Server {
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    // The request target is whatever the caller sent: `GET //[ HTTP/1.1` is accepted by Node's
    // parser and makes `new URL` throw, which would otherwise end the process.
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://agent.local");
    } catch {
      return send(400, { error: "bad request" });
    }
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
  // A malformed request that Node rejects before it reaches the handler gets an answer, not a crash.
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    else socket.destroy();
  });
  return server;
}
