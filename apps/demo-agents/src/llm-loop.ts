import {
  type AgentRunSummary,
  type AgentTask,
  type AgentToolbox,
  agentToolDefinitions,
  type ChatClient,
  type ChatMessage,
  type ChatResponse,
} from "@bonded/shared";

/**
 * The generic tool-calling loop every LLM brain shares (ADR-006): it calls the model, runs
 * the tool calls it asks for through the toolbox, and stops on a natural finish, an error or
 * the step cap. Brains differ only in their system prompt and in the toolbox they hand in
 * (hardened-agent wraps the Arena's toolbox in its guard).
 */
export interface ToolLoopOptions {
  client: ChatClient;
  model: string;
  system: string;
  task: AgentTask;
  tools: AgentToolbox;
}

export async function runToolLoop(options: ToolLoopOptions): Promise<AgentRunSummary> {
  const { client, model, system, task, tools } = options;
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: `Task: ${task.goal}` },
  ];
  const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let costReported = false;
  let steps = 0;
  /** The run summary, with cost included only when the endpoint reported it. */
  const summary = (
    stoppedBecause: AgentRunSummary["stoppedBecause"],
    finalMessage?: string,
  ): AgentRunSummary => ({
    steps,
    stoppedBecause,
    ...(finalMessage === undefined ? {} : { finalMessage }),
    usage: costReported
      ? usage
      : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  });

  // Each turn makes at least one tool call or ends, so maxSteps also bounds the turns.
  for (let turn = 0; turn < task.maxSteps + 1; turn++) {
    if (tools.signal?.aborted) return summary("error", "the episode ended");
    let response: ChatResponse;
    try {
      response = await client.complete(
        { model, messages, tools: agentToolDefinitions(), max_tokens: 4096 },
        { signal: tools.signal },
      );
    } catch (error) {
      // Stop with the usage of the turns already paid for, so a failed request partway
      // through a run still counts toward the spending cap.
      return summary("error", error instanceof Error ? error.message : String(error));
    }
    usage.inputTokens += response.usage?.prompt_tokens ?? 0;
    usage.outputTokens += response.usage?.completion_tokens ?? 0;
    if (response.usage?.cost !== undefined) {
      usage.costUsd += response.usage.cost;
      costReported = true;
    }

    const choice = response.choices[0];
    if (!choice) return summary("error", "the model returned no answer");
    const { content, tool_calls: calls = [] } = choice.message;
    messages.push({ role: "assistant", content, ...(calls.length ? { tool_calls: calls } : {}) });

    if (calls.length === 0) {
      // Providers differ on finish_reason; with no tool calls, only a natural stop is a finish.
      if (choice.finish_reason === "stop") {
        return summary("done", (content ?? "").trim());
      }
      return summary("error", `the model stopped early (${choice.finish_reason})`);
    }

    for (const call of calls) {
      if (steps >= task.maxSteps) {
        messages.push(toolMessage(call.id, { error: `step limit of ${task.maxSteps} reached` }));
        continue;
      }
      let args: unknown;
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        // A malformed call still costs a step, like any other call the agent makes.
        steps++;
        messages.push(toolMessage(call.id, { error: "arguments were not valid JSON" }));
        continue;
      }
      steps++;
      const result = await tools.call(call.function.name, args);
      messages.push(toolMessage(call.id, result.ok ? result.output : { error: result.error }));
    }
    if (steps >= task.maxSteps) return summary("max_steps");
  }
  return summary("max_steps");
}

/** A tool result message answering the model's tool call `id`. */
function toolMessage(id: string, payload: unknown): ChatMessage {
  return { role: "tool", tool_call_id: id, content: JSON.stringify(payload) };
}
