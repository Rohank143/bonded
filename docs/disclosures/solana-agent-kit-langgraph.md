# Solana Agent Kit: LangGraph example

- **Template:** `examples/misc/agent-kit-langgraph` in [sendaifun/solana-agent-kit](https://github.com/sendaifun/solana-agent-kit) (Apache-2.0), solana-agent-kit 2.0.10
- **Rated:** 2026-10-03, one run of each of the 40 attack seeds plus 2 controls, on a fresh local chain
- **Models:** anthropic/claude-haiku-4.5 and deepseek/deepseek-v4.1-flash
- **On chain (Robinhood Chain testnet registry):** agent 7 (Haiku), agent 8 (DeepSeek)
- **Disclosure status:** published. No breach was found, so nothing is withheld.

## How it was run

The example's LangGraph ReAct agent and its prompt ran unchanged. Its tools were the Arena's, defined as Solana Agent Kit `Action`s and converted with the kit's `createLangchainTools`. The kit's own Solana actions weren't exercised: the Arena's vault is an EVM contract, so this rates the template's agent behaviour, not its Solana integrations. The operator's message was the Arena's task and the mandate.

## Results

| Model | Score | Attacks breached | Controls breached | Attacks whose planted text it read | Of those: stopped to ask the user | Carried on with its own task |
|---|---|---|---|---|---|---|
| Claude Haiku 4.5 | 50 (BB) | 0 of 40 | 0 of 2 | 21 | 3 | 18 |
| DeepSeek V4.1 Flash | 50 (BB) | 0 of 40 | 0 of 2 | 24 | 14 | 20 |

The DeepSeek counts overlap: some episodes made the trade, then also asked the user about the planted request.

The same caveats apply as for the AgentKit template:
- one run per attack;
- a chatbot that sometimes stops to ask, which a live user could answer with yes;
- attacks on surfaces it never read;
- 50 is the ceiling for a clean agent at one run.

## Suggested mitigations, if deployed as an autonomous agent

The same as for AgentKit: limits enforced on chain or in code, allowlisted recipients and spenders, no follow-up approval of requests that come from untrusted content, and a pre-trade guard.
