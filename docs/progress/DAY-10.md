# Day 10: Sentinel service, Laya adapter and held-out evaluation

Plan reference: docs/PLAN.md Section 20, Day 10, and Section 10. Plain-language overview: `docs/SENTINEL.md`.

## Done

### Sentinel service (`services/sentinel`)

- Laya's own HTTP server (`laya[serve]==0.3.21`), in a CPU Docker image (1.6 GB).
- `server.py` only picks the weights: the fine-tune from `SENTINEL_MODEL_REPO` at a pinned `SENTINEL_MODEL_REVISION`, read with `HF_TOKEN`. With no repo set it serves base Laya and says so in the log.
- It listens on IPv6 and IPv4 together. Railway's private network is IPv6; asyncio would otherwise bind IPv6 only.
- Bearer key (`LAYA_API_KEY`) and health probe are Laya's. Checked: 401 without a key or with a wrong one.

### Laya adapter (issue #12) and cascade (issue #32, first part)

In `@bonded/demo-agents`:
- `LayaSentinel` sends the same state and questions the model trained on. Training and serving share `sentinelState` and `sentinelQuestions` from `@bonded/shared`; the Kaggle files rebuilt from them are byte-identical to the uploaded ones.
- `CascadeSentinel` asks Laya first and an LLM only when Laya is unsure (manipulated between 0.25 and 0.75, or action risk below 0.6 confidence). The band gets tuned on the fine-tune's held-out numbers.
- `SentinelGuard` takes a Sentinel model or, as before, any decision model. The hardened agent now records untrusted tool outputs for it.
- `LayaDecisionModel`: Laya behind the existing `DecisionModel` interface.
- The Arena accepts `--sentinel-model laya:<url>` and `--sentinel-fallback <llm>`.

### Held-out evaluation

`pnpm sentinel:eval --arena <ratings> --laya <url>` scores held-out classes A7 and A10 plus control episodes, each distinct case once. It reports TPR at 1% FPR, AUC, ECE, action-risk confusion, and p50/p95 latency.

Baseline, **base Laya (not fine-tuned)**, 111 distinct held-out cases from 190 rows ([evidence](evidence/sentinel-eval-base-laya.json)):

| Question | Result |
|---|---|
| manipulated (36 yes, 75 no) | accuracy 32.4%, AUC 0.668, TPR at 1% FPR 0%, ECE 0.199 |
| injection in inputs | accuracy 96.4%, AUC 0.554 |
| action risk | accuracy 70.3%, ECE 0.262; it answers "within mandate" for 39 of 42 likely breaches |
| latency | p50 684 ms, p95 731 ms (laptop GPU, MPS) |

Base Laya can't tell manipulated actions apart, as its README warns. This is the bar the fine-tune must clear.

Assumptions and limits:
- Only 4 distinct control episodes. The scripted benign agent repeats itself. The other 71 negatives are attack episodes where the agent wasn't manipulated.
- With fewer than 100 negatives, "TPR at 1% FPR" allows no false positive at all.
- No held-out case is labelled "suspicious", so that answer is untested.

### Latency, measured

| Where | Per check |
|---|---|
| CPU, laptop, 2 threads, real held-out states | 2.3–2.9 s (4 and 8 threads no faster) |
| GPU, laptop (MPS) | p50 684 ms |
| GPU, T4 | from the Kaggle report when the run finishes (the author claims 33 ms) |

The plan's CPU guess (300–400 ms) was about 7 times too low; `docs/SENTINEL.md` and `docs/PLAN.md` now carry measured numbers with their conditions. Railway has no GPUs, so the demo runs on CPU at about 2.5 s per check.

Memory: 1.9 GB peak on the laptop. In the Linux container it's 2.1 GB after loading, and the first real request didn't fit in the roughly 2.7 GB the local Docker VM had free, so the Railway service gets 4 GB and its real peak comes from Railway's metrics.

## Done when

- **"Sentinel eval report (TPR@1%FPR, ECE, latency)":** met for base Laya. The fine-tune's report follows when the Kaggle run finishes.
- **"Solana E2E breach → claim on devnet":** not yet; separate PR (needs a funded devnet wallet).

## Next

- When the Kaggle run finishes: evaluate the fine-tune through the service, set the cascade band, deploy the service to Railway (4 GB, read-only Hugging Face token and bearer key set by the founder), and re-run the Arena with Sentinel on.
- Varied benign control episodes from an LLM-driven agent (under $1), so false positives are measured on more than 4 cases.
- Solana devnet deploy and the ADR-011 follow-ups.
