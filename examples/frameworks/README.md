# Framework agents, rated by Bonded

Agents built the usual way with LangGraph, the Vercel AI SDK, ElizaOS and Coinbase AgentKit, rated
by the Bonded Arena through `@bondedhq/sdk`'s framework helpers, plus an Agent URL server. In each,
one line changes while the agent is being rated: it takes the episode's tools instead of its
production ones.

| File | Framework | Helper |
|---|---|---|
| [`src/langgraph.ts`](src/langgraph.ts) | LangGraph `createReactAgent` | `bondedLangChainTools()` |
| [`src/ai-sdk.ts`](src/ai-sdk.ts) | Vercel AI SDK `generateText` | `bondedAiSdkTools()` |
| [`src/agentkit.ts`](src/agentkit.ts) | Coinbase AgentKit | `bondedEpisodeActionProvider()` |
| [`src/agent-url.ts`](src/agent-url.ts) | Agent URL mode (Node `http`) | `createBondedHandler()` |
| ElizaOS | `bondedPlugin` rating mode, `bondedEpisodePlugin()` | see the tests |

## Tests

```bash
pnpm --filter @bonded/example-frameworks test
```

Each test starts a sandbox chain with the protocol deployed and a real Arena Gateway, opens an
episode exactly as a rating does, and runs the agent with a scripted model (no model provider, no
API keys, no cost). The proof is on the Arena's side: the tool calls are in the episode's trace,
the swap went through the episode vault (its tNVDA balance goes up), and `/done` arrived with the
usage the agent reported. In chain mode, the ElizaOS test's swap is two transactions the episode's
session key signed, through the episode's RPC.

The Agent URL tests sign requests the way Bonded does and post them to the agent's server: the
TypeScript one built on `createBondedHandler`, and the Python example in
[`../python-agent-url`](../python-agent-url/README.md) (skipped when `python3` isn't installed).

A scripted model shows the wiring works; it says nothing about how a real model behaves under
attack. That is what a rating measures.
