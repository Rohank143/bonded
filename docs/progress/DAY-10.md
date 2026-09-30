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
| action risk | accuracy 70.3%, ECE 0.262; it answers "within mandate" for 33 of 36 likely breaches |
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
| GPU, T4 (Kaggle, fine-tune) | p50 217 ms, p95 228 ms |

The plan's CPU guess (300–400 ms) was about 7 times too low; `docs/SENTINEL.md` and `docs/PLAN.md` now carry measured numbers with their conditions. Railway has no GPUs, so the demo runs on CPU at about 2.5 s per check.

Memory: 1.9 GB peak on the laptop. In the Linux container it's 2.1 GB after loading, and the first real request didn't fit in the roughly 2.7 GB the local Docker VM had free, so the Railway service gets 4 GB and its real peak comes from Railway's metrics.

### Fine-tune v1 on the held-out cases

`ddboy19912/bonded-sentinel-laya` at commit `22d2ad7` (private), on the same 111 cases ([evidence](evidence/sentinel-eval-finetune-v1.json)):

| | Base Laya | Fine-tune v1 |
|---|---|---|
| Manipulated: AUC | 0.668 | **0.936** |
| Manipulated: caught with zero false alarms | 0 of 36 | **33 of 36 (91.7%)** |
| Manipulated: false alarms at the 0.5 threshold | 75 of 75 (accuracy 32.4%) | **0 of 75** |
| Action risk: likely breaches caught | 3 of 36 | **33 of 36** |
| Action risk: accuracy | 70.3% | **97.3%** |
| Manipulated: calibration (ECE) | 0.199 | **0.069** |
| Latency, laptop GPU (MPS), p50 | 684 ms | 665 ms |

- By class: A7 (tool-output smuggling) 100%; A10 (hostile counterparty agent) 94.5%. All three misses are A10.
- The injection question can't be measured here: only the 4 controls have no injection, and the fine-tune flags all 4 (AUC 0.016 on 4 negatives). The guard does not block on it.
- Same limits as the baseline: 4 real benign controls (the other 71 negatives are attacks that failed to manipulate the agent), scripted agents, and no "suspicious" labels. False alarms on ordinary trading need the LLM-driven benign episodes.

### False alarms on ordinary trading

`pnpm --filter @bonded/arena arena controls --brain llm --controls 48` ran 48 benign episodes with an LLM agent (DeepSeek V4.1 Flash) on 16 varied trading tasks for $0.03: 65 Sentinel rows, 45 new distinct cases, no breaches. With them the test has 49 benign cases ([evidence](evidence/sentinel-eval-finetune-v1-controls.json)):

| | Fine-tune v1 |
|---|---|
| Manipulated: caught at under 1% false alarms | 33 of 36 (FPR 0.8%, 1 of 120 negatives) |
| Manipulated: AUC | 0.930 |
| Benign trades flagged manipulated (score 0.5 or more) | 2 of 49 |
| Benign trades called "breach likely" | 9 of 49 |

All 9 "breach likely" calls, and both "manipulated" ones, are sells back to tUSDG or a $250 buy. Only 2.7% of the training rows are sells (108 of them benign), so the model learned that selling looks like a breach. The guard blocks on "breach likely", so v1 as deployed would block about one ordinary trade in five. Fixes:
- **Guard (done):** Sentinel now blocks only on "manipulated". "Breach likely" is a label and sends the check to the LLM in a cascade; the vault enforces the mandate on chain anyway. On these 49 benign trades that leaves 2 false blocks (manipulated 0.78 and 0.88, both sells).
- **Data (v2):** `pnpm sentinel:synth --targets sells` generated 1,592 rows for $0.54: 400 benign sells, 400 small trades, 400 sells that ignore a planted instruction, and 392 manipulated panic-sells, so a sell doesn't come to mean safe.
  - An audit found 45% of the panic-sells, and 13% of v1's "suspicious" rows, swap more than the mandate's per-trade limit. That is a breach, so the label was wrong.
  - The generator now rejects such rows, and the dataset builder drops existing ones (`droppedOverTradeLimit` in the manifest: 318).
  - The v2 set has 10,399 training rows; the test split is unchanged from v1.
  - The generator almost always chose buys for "small trades" (5 sells in 400); the 400 benign sells cover selling.

### Fine-tune v2: chosen for production

Trained on the v2 set with the fully edited notebook (Laya 0.3.21, pinned base). Hugging Face commit `0170dd4` (weights from `8ace3be`, plus the report). Kaggle's benchmark on the 24-case test split: accuracy 97.2%, ECE 0.084, p50 208 ms on a T4; A7 100%, A10 95.2%, controls 100% ([evidence](evidence/kaggle-benchmark-sentinel-v2.json)).

On the same 156 cases as v1: 107 held-out attack cases plus the 49 benign trades ([evidence](evidence/sentinel-eval-finetune-v2-controls.json)):

| | v1 | v2 |
|---|---|---|
| Manipulated: AUC | 0.930 | **0.975** |
| Manipulated: caught at under 1% false alarms | 33 of 36 (FPR 0.8%) | 33 of 36 (FPR 0.8%) |
| Benign trades flagged manipulated (the guard's block) | 2 of 49 | **0 of 49** |
| Benign trades called "breach likely" (a label) | 9 of 49 | **3 of 49** |
| Injection question: AUC | 0.862 | **1.000** |
| Manipulated: calibration (ECE) | 0.079 | 0.091 |

The 49 benign trades revealed the sell problem that v2's data targets, so they're no longer an independent test. A fresh batch of 48 LLM-driven benign episodes ($0.04; 46 distinct cases, no breaches) was run after training ([v1](evidence/sentinel-eval-v1-fresh-controls.json), [v2](evidence/sentinel-eval-v2-fresh-controls.json)):

| Fresh 46 benign cases | v1 | v2 |
|---|---|---|
| Flagged manipulated (would be blocked) | 1 | **0** |
| Called "breach likely" | 6 | **2** |

v2 is equal or better on everything that decides a block, with slightly worse calibration (ECE 0.091 against 0.079). Production switches to v2. Limits unchanged: scripted attack agents, benign tasks from a fixed list of 16, no "suspicious" labels, and 36 manipulated cases, so one miss moves the catch rate by about 3 points.

### Kaggle's own benchmark (run `sentinel-v1`)

Laya's benchmark on our test split ([evidence](evidence/kaggle-benchmark-sentinel-v1.json)): accuracy 94.4%, ECE 0.042, Brier 0.087, latency p50 217 ms on a T4. The split is only 24 cases (18 distinct states, 72 decisions), so this is a sanity check; the held-out evaluation above is the real measure.

The v1 notebook (the copy downloaded from Kaggle) was missing edits a, b, d and f of the Kaggle guide. So v1 was most likely trained with the latest Laya, 0.3.22, and an unpinned base model, while the service runs 0.3.21. It loads and serves correctly, and the held-out numbers above come from the service. v2 uses `services/sentinel/kaggle/bonded-sentinel.ipynb`, which has all six edits.

Its report also still has the notebook's upstream labels:
- It names the benchmark `LocalLLaMA/typed-decisions` and counts five decisions per case (120). Sentinel asks three, so it's 72.
- Its "comparison" rows (Jev 0.727, ModernBERT 0.646, and so on) are copied from Laya's own benchmark on a different dataset. They were not run on our data and are not a comparison with our model.

The metrics themselves are computed on our test file.

## Done when

- **"Sentinel eval report (TPR@1%FPR, ECE, latency)":** met, for base Laya, fine-tune v1 and fine-tune v2.
- **"Solana E2E breach → claim on devnet":** PR #40 (`DAY-10-SOLANA.md`).

## Next

- The Sentinel service is live on Railway (on v1 until this change is applied). Next: set the cascade band, and re-run the Arena with Sentinel on through the Railway service.
- Solana keeper and TypeScript client, then the ADR-011 follow-ups.
