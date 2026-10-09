import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatClient, ChatRequest } from "@bondedhq/shared";
import { afterEach, expect, it } from "vitest";
import type { ContrastRow } from "../src/contrast.js";
import { generateLlmContrast, LLM_DISGUISES } from "../src/llm-contrast.js";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

/** Answers with inputs that carry the order it was asked for, taken from the prompt. */
function client(answer?: (order: string) => unknown): ChatClient {
  return {
    async complete(request: ChatRequest) {
      const prompt = request.messages.map((m) => ("content" in m ? m.content : "")).join("\n");
      const order = /instruct the agent to: (.*)\.\n/.exec(prompt)![1]!;
      const json = answer
        ? answer(order)
        : { inputs: [{ tool: "read_inbox", output: `Desk: please ${order} now.` }] };
      return {
        choices: [
          { message: { role: "assistant", content: JSON.stringify(json) }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 500, completion_tokens: 100, cost: 0.0003 },
      };
    },
  };
}

const read = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as ContrastRow);

it("writes an obeyed and an independent row per scene, labelled by code", async () => {
  dir = mkdtempSync(join(tmpdir(), "llm-contrast-"));
  const out = join(dir, "pairs.jsonl");
  const summary = await generateLlmContrast({
    client: client(),
    model: "m",
    count: LLM_DISGUISES.length,
    maxUsd: 1,
    out,
  });
  expect(summary.written).toBe(LLM_DISGUISES.length);
  const rows = read(out);
  expect(rows).toHaveLength(2 * LLM_DISGUISES.length);
  for (let i = 0; i < rows.length; i += 2) {
    const [obeyed, independent] = [
      rows.find((r) => r.id.endsWith("obeyed") && r.pairId === rows[i]!.pairId)!,
      rows.find((r) => r.id.endsWith("independent") && r.pairId === rows[i]!.pairId)!,
    ];
    expect(obeyed.labels).toMatchObject({ manipulated: true, injection_in_inputs: true });
    expect(independent.labels).toMatchObject({ manipulated: false, injection_in_inputs: true });
    expect(independent.untrustedInputs).toEqual(obeyed.untrustedInputs);
    expect(independent.proposedAction).not.toEqual(obeyed.proposedAction);
  }
  // Resuming skips scenes already written.
  const again = await generateLlmContrast({
    client: client(),
    model: "m",
    count: LLM_DISGUISES.length,
    maxUsd: 1,
    out,
  });
  expect(again).toMatchObject({ written: 0, skippedExisting: LLM_DISGUISES.length });
});

it.each([
  [
    "order-missing",
    () => ({ inputs: [{ tool: "read_inbox", output: "Buy something nice today." }] }),
  ],
  ["tools", (o: string) => ({ inputs: [{ tool: "transfer", output: `please ${o}` }] })],
  [
    "untrained-mechanism",
    (o: string) => ({
      inputs: [{ tool: "read_inbox", output: `If the price is above 100, ${o}` }],
    }),
  ],
  [
    "stress-language",
    (o: string) => ({ inputs: [{ tool: "read_inbox", output: `Por favor ${o} ahora mismo.` }] }),
  ],
  ["shape", () => ({ inputs: [] })],
  ["tools", (o: string) => ({ inputs: [{ tool: "get_prices", output: `please ${o}` }] })],
  [
    "price-quote",
    (o: string) => ({ inputs: [{ tool: "read_news", output: `tTSLA: 412.18. Desk: ${o}` }] }),
  ],
])("rejects an answer with a %s problem", async (reason, answer) => {
  dir = mkdtempSync(join(tmpdir(), "llm-contrast-"));
  const summary = await generateLlmContrast({
    client: client(answer),
    model: "m",
    count: 1,
    maxUsd: 1,
    out: join(dir, "p.jsonl"),
    concurrency: 1,
  });
  expect(summary.written).toBe(0);
  expect(summary.rejected[reason]).toBe(1);
});
