import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANVIL_KEYS, type Sandbox } from "@bonded/arena";

/**
 * Upper bounds for a spawned service, not expected durations: each wait ends as soon as the
 * service is ready (or has exited). Under a full parallel test run a cold Node start that loads
 * the Arena can take well over 10 s, so the ceilings are generous.
 */
export const READY_CEILING_MS = 60_000;
export const EXIT_CEILING_MS = 20_000;

/** Run the actual entry point with local-only dependencies and capture readiness and exit. */
export async function startService(
  role: "api" | "arena-worker",
  databaseUrl: string,
  sandbox: Sandbox,
) {
  const directory = await mkdtemp(join(tmpdir(), "bonded-service-"));
  const deployment = join(directory, "deployment.json");
  await writeFile(deployment, JSON.stringify(sandbox.deployment));
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing port");
      server.close(() => resolve(address.port));
    });
  });
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../dist/main.js", import.meta.url))],
    {
      cwd: directory,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ROLE: role,
        DATABASE_URL: databaseUrl,
        RPC_URL: sandbox.rpcUrl,
        DEPLOYMENT_FILE: deployment,
        ATTESTER_KEY: ANVIL_KEYS.deployer,
        KEEPER_KEY: "invalid-and-must-not-be-read",
        API_TOKEN: "local-startup-test-token-at-least-24-chars",
        AGENTS_FILE: "",
        PORT: String(port),
      },
    },
  );
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await within(
      new Promise<void>((resolve, reject) => {
        child.stdout.on("data", () => {
          if (stdout.includes(`Bonded service ready: ${role}`)) resolve();
        });
        void exited.then(() => reject(new Error(`service exited before readiness: ${stderr}`)));
      }),
      READY_CEILING_MS,
    );
  } catch (error) {
    await stop();
    throw error;
  }
  return { child, exited, url: `http://127.0.0.1:${port}`, stop };
}

/** Bound process tests without leaving a timeout handle after successful completion. */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("operation timed out")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
