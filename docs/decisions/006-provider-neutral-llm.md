# ADR-006: Provider-neutral LLM access

- **Status:** Accepted
- **Date:** 2026-09-28
- **Supersedes:** the Claude-only parts of ADR-005 (decision 6) and PLAN Sections 8.3, 8.5, 10.3 and 16
- **Code:** `packages/shared/src/llm.ts`, `apps/demo-agents/src/vulnerable/llm.ts`

## Context

The plan assumed Claude for every language-model job: the attacker, the grey-area judge, synthetic training data and the demo agents' brains. Day 5 built the demo agent's brain on Anthropic's SDK, so it could only use Claude.

Two things changed that:
- **Cost.** A full rating is about 240 episodes, and the demo agent's multi-turn tool loop is the biggest cost.
  - **Assumptions:** about 10 turns per episode, 40k input and 5k output tokens per episode for the agent, and 3k in / 1k out per attack variant. That's roughly 10M input and 1.4M output tokens per rating.
  - **Claude Opus 5** ($5 / $25 per million tokens in/out) comes to about $55 per rating.
  - **Open models on OpenRouter** are far cheaper, but prices vary by provider.
    - **DeepSeek V4.1 Flash:** the model page lists $0.035 / $0.29, and individual providers charge around $0.10 / $0.50 (OpenRouter provider list, September 2026). At the higher provider rate that's about $1.70 per rating.
    - **GLM 5.3 Flash:** the model page lists $0.045 / $0.14, and providers charge up to about $0.14 / $0.47.
  - These are estimates from list prices. The client reports each request's actual cost, and runs will be capped and reported from measured spend (Day 6), not from this table.
- **Choice.** Which model is best for each job (attacking, playing a typical agent, labelling) is an empirical question, and the answer will change month to month. The code shouldn't pick for us.

## Decisions

### 1. One OpenAI-compatible client for every LLM job

`@bonded/shared` has a `ChatClient` interface in the OpenAI chat-completions format (messages, function tools, tool calls). `OpenAICompatibleClient` implements it with plain `fetch`, with no vendor SDK.

That format is served by OpenRouter, OpenAI, DeepSeek, Gemini's compatible endpoint, and local servers such as Ollama and vLLM. So every current and future LLM job (demo agents, the attacker, the grey-area judge, synthetic data) runs on any model with no code change.

### 2. OpenRouter is the default endpoint; the model is a setting

- **Endpoint:** `LLM_BASE_URL` (default `https://openrouter.ai/api/v1`).
- **Key:** `LLM_API_KEY` or `OPENROUTER_API_KEY`.
- **Model:** chosen per job. The CLI takes `--model <id>`. Day 6 adds per-role settings (attacker, agent, judge).

One OpenRouter key reaches hundreds of models, including Claude, so Claude stays one option among many rather than a dependency. OpenRouter's platform fee is about 5.5% on credit purchases.

### 3. The demo agent's default brain is a cheap, popular model

`vulnerable-agent` defaults to `deepseek/deepseek-v4.1-flash`. That's realistic, because many real trading agents run on cheap models, and it keeps development runs close to free.

Using the Arena to compare how safe different models are as agent brains is a feature: the same agent can be rated on several models (plan Section 13.2, the public leaderboard).

### 4. The client is robust and reports cost

- **Retries:** rate limits, server errors and dropped connections are retried with exponential backoff (twice by default). Client errors, such as an unknown model or a bad request, fail at once with the status and response body.
- **Aborts:** the episode's abort signal cancels in-flight requests.
- **Cost:** on OpenRouter it asks for each request's cost (`usage: { include: true }`), and the agent reports tokens and cost in its run summary. This feeds Day 6's per-run spending cap. Other endpoints get a plain request, since they may reject the extra field.

### 5. The generic brain handles provider differences

Providers disagree on details, so the loop doesn't trust `finish_reason` alone:
- **Tool calls:** it executes tool calls whenever they're present, even if the provider says `stop`.
- **Finishing:** without tool calls, only `stop` counts as a finish. `length`, `content_filter` and anything else end the run as an error, so a truncated or filtered turn can't look like a clean episode.
- **Bad arguments:** arguments that aren't valid JSON go back to the model as an error result and cost a step.

## Consequences

- **The Anthropic SDK is removed** from the codebase.
- **Laya is unaffected.** It isn't a chat model and runs as its own service (plan Section 10).
- **Tool-calling quality varies** by model and by the provider OpenRouter routes to. Every malformed call is visible in the trace, and provider routing can be pinned if one misbehaves.
- **Some models refuse to write attack content.** The attacker's model is a setting, so a refusing model is swapped, not worked around.
- **No batch discount is assumed** for synthetic data. At these prices it doesn't matter.
- **An end-to-end test** runs the LLM brain against a local OpenAI-compatible server inside a real Arena episode, so the whole path is covered without a paid key.
