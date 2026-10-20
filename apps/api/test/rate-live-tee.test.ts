import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../../../scripts/rate-live-tee.sh", import.meta.url));

it("rejects remote plaintext and malformed API URLs before prompting or touching a VM", async () => {
  for (const API_URL of [
    "http://localhost@attacker.example",
    "http://localhost.attacker.example",
    "http://127.0.0.1.attacker.example",
    "http://attacker.example",
    "https://[",
    "https://example.com:bad",
  ]) {
    const result = await run("bash", [script, "1"], {
      env: { ...process.env, API_URL },
      timeout: 5000,
    }).catch((error) => error);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/API_URL must use https/);
    expect(result.stdout).not.toMatch(/Starting|Stopping|API token/);
  }
});

it("never puts a non-ASCII character right after an unbraced variable", async () => {
  // In a UTF-8 locale on macOS, bash reads `$CVM_NAME…` as one variable name and, with `set -u`,
  // stops with "unbound variable" after the token prompt. Braces end the name.
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(script, "utf8");
  const bad = [...text.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)(.)/gu)]
    .filter((m) => m[2]!.charCodeAt(0) > 127)
    .map((m) => m[0]);
  expect(bad).toEqual([]);
});

/**
 * A fake `phala`, `curl` and `sleep` on PATH, so the script's whole flow runs in a moment with no
 * VM or API. `curl` answers the status poll from a list (one entry per call, "fail" for no
 * answer); `phala cvms stop` fails as many times as asked before it works.
 */
async function fakeRun(opts: { polls: string[]; stopFailures: number }) {
  const { mkdtempSync, writeFileSync, chmodSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "rate-live-tee-"));
  const bin = join(dir, "bin");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(bin);
  writeFileSync(join(dir, "polls"), opts.polls.join("\n") + "\n");
  writeFileSync(join(dir, "stop-failures"), String(opts.stopFailures));
  writeFileSync(join(dir, "vm"), "stopped");
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\nD='${dir}'\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  tool("sleep", "exit 0");
  tool(
    "phala",
    `case "$2" in
  start) echo running > "$D/vm" ;;
  get) printf '{"status":"%s"}' "$(cat "$D/vm")" ;;
  stop) echo stop >> "$D/stop-calls"; n=$(cat "$D/stop-failures")
        if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$D/stop-failures"; exit 1; fi
        echo stopped > "$D/vm" ;;
esac`,
  );
  tool(
    "curl",
    `url="\${@: -1}"
case "$*" in
  *"-X POST"*) cat >/dev/null; echo '{"runId":"run-1"}'; exit 0 ;;
esac
case "$url" in
  */health) echo '{"ok":true}' ;;
  */arena/runs/run-1)
    line=$(head -1 "$D/polls"); tail -n +2 "$D/polls" > "$D/polls.next"; mv "$D/polls.next" "$D/polls"
    case "$line" in
      fail) exit 22 ;;
      empty) exit 0 ;;
      *) printf '{"status":"%s","report":{"scoring":{"score":97,"tier":"AAA"},"tee":null}}' "$line" ;;
    esac ;;
  */score) echo '{"tx_hash":"0xabc","signed":{"attestation":{"teeMeasurement":"0xdef"}}}' ;;
esac`,
  );
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    const child = execFile(
      "bash",
      [script, "2"],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TMPDIR: dir,
          CVM_NAME: "test-vm",
          API_URL: "https://api.example",
        },
        timeout: 20_000,
      },
      (error, stdout, stderr) =>
        done({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin!.end("token\n");
  });
  const stopCalls = (() => {
    try {
      return readFileSync(join(dir, "stop-calls"), "utf8").trim().split("\n").length;
    } catch {
      return 0;
    }
  })();
  return { ...result, vm: readFileSync(join(dir, "vm"), "utf8").trim(), stopCalls };
}

it("keeps polling through missed or empty answers, and the run still finishes", async () => {
  const r = await fakeRun({
    polls: ["running", "fail", "empty", "running", "done"],
    stopFailures: 0,
  });
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/no answer from the API, 2 in a row/);
  expect(r.stdout).toMatch(/score 97 AAA/);
  expect(r.vm).toBe("stopped");
});

it("retries stopping the VM until it is stopped", async () => {
  const r = await fakeRun({ polls: ["done"], stopFailures: 2 });
  expect(r.code).toBe(0);
  expect(r.stopCalls).toBe(3);
  expect(r.vm).toBe("stopped");
});

it("gives up after many missed polls, and still stops the VM", async () => {
  const r = await fakeRun({ polls: Array(10).fill("fail"), stopFailures: 0 });
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/Run run-1 may still finish/);
  expect(r.vm).toBe("stopped");
});
