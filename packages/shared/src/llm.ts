/**
 * Provider-neutral access to language models. See ADR-006.
 *
 * Everything in Bonded that needs an LLM (demo agents, the attacker, the grey-area judge)
 * talks to it through `ChatClient`, using the OpenAI-compatible chat-completions format that
 * OpenRouter, OpenAI, DeepSeek, Gemini's compatible endpoint and local servers (Ollama, vLLM)
 * all speak. The model is a setting, never a code change. OpenRouter is the default endpoint
 * because one key reaches hundreds of models, including Claude.
 */

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  max_tokens?: number;
  temperature?: number;
}

export interface ChatResponse {
  id?: string;
  model?: string;
  choices: {
    message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] };
    /** "stop", "tool_calls", "length", "content_filter", ... (providers vary). */
    finish_reason: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

export interface ChatClient {
  complete(request: ChatRequest, options?: { signal?: AbortSignal }): Promise<ChatResponse>;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * Reads the endpoint and key from the environment:
 * - LLM_BASE_URL: any OpenAI-compatible endpoint (default: OpenRouter)
 * - LLM_API_KEY, or OPENROUTER_API_KEY
 */
export function llmConfigFromEnv(env: Record<string, string | undefined> = process.env): LlmConfig {
  const apiKey = env.LLM_API_KEY ?? env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("no LLM API key: set OPENROUTER_API_KEY (or LLM_API_KEY with LLM_BASE_URL)");
  }
  return { baseUrl: (env.LLM_BASE_URL ?? OPENROUTER_BASE_URL).replace(/\/+$/, ""), apiKey };
}

/** An HTTP error from the endpoint, with its status and (truncated) body. */
export class LlmError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

export interface OpenAICompatibleClientOptions {
  /** Retries for rate limits, server errors and dropped connections (default 2). */
  maxRetries?: number;
  /** Base delay between retries in ms, doubled each time (default 1000). */
  retryDelayMs?: number;
  fetch?: typeof fetch;
}

/** A `ChatClient` for any OpenAI-compatible chat-completions endpoint. */
export class OpenAICompatibleClient implements ChatClient {
  private readonly isOpenRouter: boolean;
  private readonly fetch: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly config: LlmConfig,
    options: OpenAICompatibleClientOptions = {},
  ) {
    this.isOpenRouter = new URL(config.baseUrl).hostname.endsWith("openrouter.ai");
    this.fetch = options.fetch ?? fetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
  }

  /**
   * Sends one chat-completion request and returns the response. Retries rate limits, server
   * errors and dropped connections; throws `LlmError` for other HTTP errors.
   */
  async complete(
    request: ChatRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ChatResponse> {
    // OpenRouter reports each request's cost when asked; other endpoints may reject the field.
    const body = this.isOpenRouter ? { ...request, usage: { include: true } } : request;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetch(`${this.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            "content-type": "application/json",
            ...(this.isOpenRouter ? { "x-title": "Bonded Arena" } : {}),
          },
          body: JSON.stringify(body),
          signal: options.signal,
        });
      } catch (error) {
        if (options.signal?.aborted || attempt >= this.maxRetries) throw error;
        await this.wait(attempt, options.signal);
        continue;
      }
      if (response.ok) return (await response.json()) as ChatResponse;
      const text = (await response.text()).slice(0, 500);
      if (!RETRYABLE.has(response.status) || attempt >= this.maxRetries) {
        throw new LlmError(response.status, `LLM request failed (${response.status}): ${text}`);
      }
      await this.wait(attempt, options.signal);
    }
  }

  /** Waits before a retry; rejects at once if the episode is (or becomes) aborted. */
  private wait(attempt: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        this.retryDelayMs * 2 ** attempt,
      );
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
