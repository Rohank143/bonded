# @bonded/demo-agents

The agents Bonded rates in the Arena: the vulnerable and hardened brains, the policy guard, the demo's Agent A (`createPartialAgent`), the decision-model agent and the framework adapters (Coinbase AgentKit, Solana Agent Kit).

What each one is, how it's judged and how they compare: [docs/AGENTS.md](../../docs/AGENTS.md).

| Path | What's there |
|---|---|
| `src/vulnerable/` | Acts on instructions it reads (script or language model) |
| `src/hardened/` | Treats what it reads as data, plus the policy guard (`guard.ts`) |
| `src/guarded.ts` | Any agent with guards in front of its writes (e.g. Sentinel) |
| `src/decision/` | A decision model (Laya or any chat model) in a trading loop |
| `src/frameworks/` | Adapters that run open-source agent templates unchanged |
