import type { TeeBackend } from "./backend.js";
import { DstackBackend } from "./dstack.js";
import { AgentIdentity } from "./identity.js";
import { MockBackend } from "./mock.js";
import { createTeeServer } from "./server.js";

async function main(): Promise<void> {
  const mode = process.env.TEE_BACKEND ?? "dstack";
  if (mode !== "dstack" && mode !== "mock") throw new Error(`unknown TEE_BACKEND ${mode}`);
  const backend: TeeBackend = mode === "mock" ? new MockBackend() : new DstackBackend();
  if (mode === "mock") console.warn("TEE_BACKEND=mock: no hardware, no real quote, no badge.");
  const identity = await AgentIdentity.create(backend, process.env.CODE_HASH ?? "");
  const port = Number(process.env.PORT ?? 8080);
  createTeeServer(identity, backend.name).listen(port, "0.0.0.0", () => {
    console.log(`TEE agent listening on :${port} (${backend.name})`);
    console.log(`EVM ${identity.evmAddress} · Solana ${identity.solanaPublicKey}`);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
