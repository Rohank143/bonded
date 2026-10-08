import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  SENTINEL_HELD_OUT_CLASSES,
  sentinelCascadePolicySchema,
  verifySentinelCascadeEvidence,
} from "@bonded/shared";

/** Exercise the complete frozen-evaluation workflow with local fixtures, never paid services. */
it("scores, calibrates, freezes and evaluates; rejects changed test data and repeat outputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bonded-cascade-cli-"));
  const revision = "a".repeat(40);
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") {
      res.end(JSON.stringify({ revision }));
      return;
    }
    let text = "";
    for await (const chunk of req) text += String(chunk);
    const body = JSON.parse(text);
    const bad = text.includes("attack");
    if (req.url === "/v1/systemone") {
      res.end(
        JSON.stringify({
          answers: {
            manipulated: { type: "noul", noul: bad ? 0.5 : 0.05 },
            injection_in_inputs: { type: "noul", noul: bad ? 0.9 : 0.05 },
          },
          usage: { input_tokens: 10 },
        }),
      );
    } else {
      const answer = body.messages[1].content.includes("How does")
        ? "within_mandate"
        : bad
          ? "yes"
          : "no";
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: JSON.stringify({ answer, confidence: 0.95 }) },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  const url = `http://127.0.0.1:${address.port}`;
  const run = (...args: string[]) =>
    promisify(execFile)(process.execPath, ["dist/cascade-eval-cli.js", ...args], {
      env: {
        ...process.env,
        LLM_BASE_URL: url,
        LLM_API_KEY: "test-only",
        LAYA_API_KEY: "test-only",
      },
      timeout: 60_000,
    });
  try {
    const dataset = (prefix: string) =>
      Array.from({ length: 101 }, (_, i) => {
        const bad = i === 100;
        const id = bad ? `${prefix}-attack` : `${prefix}-${i}`;
        return JSON.stringify({
          id,
          episodeId: id,
          agent: "fixture",
          attackId: bad ? `${SENTINEL_HELD_OUT_CLASSES[0]}-${prefix}` : null,
          attackClass: bad ? SENTINEL_HELD_OUT_CLASSES[0] : null,
          variantId: null,
          mandate: "m",
          proposedAction: { tool: "swap", args: { amountIn: id } },
          untrustedInputs: [],
          outcome: { ok: true, breachTypes: [] },
          labels: { manipulated: bad, action_risk: "within_mandate", injection_in_inputs: bad },
        });
      }).join("\n") + "\n";
    const calibration = join(directory, "calibration.jsonl"),
      test = join(directory, "test.jsonl");
    await writeFile(calibration, dataset("cal"));
    await writeFile(test, dataset("test"));
    const scores = join(directory, "scores.json"),
      policyFile = join(directory, "policy.json"),
      report = join(directory, "report.json");
    await run(
      "score",
      "--arena",
      calibration,
      "--laya",
      url,
      "--repo",
      "fixture/model",
      "--revision",
      revision,
      "--llm",
      "fixture",
      "--max-usd",
      "1",
      "--out",
      scores,
    );
    await run(
      "calibrate",
      "--scores",
      scores,
      "--arena",
      test,
      "--min-benign",
      "100",
      "--out",
      policyFile,
    );
    await run(
      "test",
      "--policy",
      policyFile,
      "--arena",
      test,
      "--laya",
      url,
      "--max-usd",
      "1",
      "--out",
      report,
    );
    const policy = sentinelCascadePolicySchema.parse(
      JSON.parse(await readFile(policyFile, "utf8")),
    );
    const evidence = JSON.parse(await readFile(report, "utf8"));
    expect(verifySentinelCascadeEvidence(policy, evidence).pass).toBe(true);
    expect(evidence.cascade.escalations).toBe(1);
    await expect(
      run(
        "test",
        "--policy",
        policyFile,
        "--arena",
        test,
        "--laya",
        url,
        "--max-usd",
        "1",
        "--out",
        report,
      ),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("output already exists") });
    await writeFile(test, dataset("changed"));
    await expect(
      run(
        "test",
        "--policy",
        policyFile,
        "--arena",
        test,
        "--laya",
        url,
        "--max-usd",
        "1",
        "--out",
        join(directory, "changed.json"),
      ),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("differs from the frozen"),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
