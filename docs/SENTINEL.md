# Sentinel: how it works, end to end

Sentinel is Bonded's real-time guard: a fine-tuned Laya model that checks each trade an agent proposes before it runs. This is the short version. Details are in plan Section 10, the Kaggle guide (`services/sentinel/kaggle/README.md`) and `docs/BUSINESS.md`.

## The flow

**1. Make training data.** Arena attacks and synthetic examples become labelled questions, such as "is this action manipulated?". `pnpm sentinel:synth` writes the synthetic examples and `pnpm sentinel:dataset` builds the training files. Attack classes A7 and A10 are kept out, so they can test it later.

**2. Train (on Kaggle, free).** Upload the files, run Laya's own notebook for about 4 to 5 hours on Kaggle's free GPUs, and save the result to a private Hugging Face repo.

**3. Host it on Railway.** It runs as one more small service next to the API, keeper and worker. On startup it downloads the private model with a Hugging Face read token stored in Railway. It answers over Railway's private network, so agent data never leaves our infrastructure. Railway has no GPUs, so it runs on CPU: about 2.5 s per check (see [Speed](#speed)). That's fine for the demo; a GPU host is a URL change later.

**4. Check every trade.** Before an agent's trade goes through:

```
agent wants to trade → Sentinel checks it (about 2.5 s on CPU, under 300 ms on an NVIDIA T4 GPU)
   ├─ looks fine        → trade goes ahead
   ├─ looks manipulated → trade blocked, vault owner alerted
   └─ unsure, or calls it a likely breach → a cheap LLM double-checks (issue #32)
```

**5. Prove it works.** Test it on real episodes from attack classes it never saw (A7, A10), then re-rate agents with Sentinel on. If breaches drop, premiums drop: the discount is earned, not asserted.

**Stress-test it.** `pnpm sentinel:stress` scores a model on 516 disguised cases in 43 families, with rule-checked labels and locked test-only variants. The weakness map for v1 and v2, and what v3 must fix, is in [SENTINEL-STRESS.md](SENTINEL-STRESS.md).

**6. Keep it fresh.** When new attacks appear, add them to the data and retrain. The new model goes live only if it scores at least as well as the old one.

**What blocks.** Only "manipulated" blocks a trade. Sentinel also answers "is this a likely breach?", but the vault already enforces the mandate on chain, so that answer is a label and a reason for the LLM double-check, not a block.

**Safety rule.** Sentinel only advises and blocks suspicious trades. Payouts are decided by the vault's on-chain breach log, so a wrong Sentinel answer can never cause a wrongful payout.

## When to retrain

A retrain costs almost nothing: a free Kaggle run plus about $4 of synthetic data. The limit is evaluation, not money, so retrain on triggers:

| Trigger | Why |
|---|---|
| A new attack class, or several new variants (bounties, incidents) | Sentinel only knows attacks it has seen |
| Misses: a breach Sentinel let through, or false alarms | Direct evidence it is out of date |
| Calibration drifts on recent labelled rows | Its confidence decides what goes to the LLM (issue #32) |
| A new Laya base release | Only if it measures better on our held-out set |

Expect one retrain now, perhaps one after Day 10, then about monthly in early production.

Every retrain must:
- pass the held-out evaluation;
- keep the previous model for rollback;
- trigger an Arena re-run, because Sentinel changes premiums.

When a held-out class has to join training, choose new held-out classes first (issue #11), or the evaluation stops being honest.

## Speed

One check is one forward pass over the mandate, the proposed action and the untrusted inputs (about 500 to 700 tokens on Arena episodes). Measured on Day 10 with base Laya, which has the same size and speed as the fine-tune:

| Where | Conditions | Per check | Source |
|---|---|---|---|
| CPU | Apple M-series laptop, PyTorch, 2 threads, real held-out states | 2.3–2.9 s (p50 about 2.6 s); 4 or 8 threads are no faster | Measured, Day 10 |
| CPU | Railway service, 2 vCPUs | Expect about the same; confirm from the service's own logs after deploy | Not yet measured |
| GPU | Apple M-series laptop GPU (MPS), 111 held-out cases | p50 684 ms, p95 731 ms | Measured, Day 10 |
| GPU | NVIDIA T4 (Kaggle), fine-tuned model, our 24 test rows | p50 217 ms, p95 228 ms | Measured, Kaggle run `sentinel-v1` |
| GPU | NVIDIA T4, the author's benchmark | about 33 ms per forward pass | Laya's README, not ours |

So Sentinel takes **under 300 ms per check on a T4 GPU** and **about 2.5 s on CPU**. The author's 33 ms is one forward pass on a short input; our check answers three questions about a 500 to 700 token state. Plan Section 10.4 had guessed 300–400 ms on CPU; the measurement is about 7 times slower.

What this means: 2.5 s is acceptable for the demo and for agents that trade minutes apart, since the check runs once before each trade. It is too slow for high-frequency agents. The cascade (issue #32) adds an LLM call only for unsure cases.

Memory: the model needs about 1.9 GB on a laptop and a little over 2 GB in the Linux container before the first request. Give the Railway service 4 GB and read its real peak from Railway's metrics. Railway bills for memory used, not the limit.

## Where to host it

| Option | Per month, always on | Verdict |
|---|---|---|
| Railway, CPU | about $20–30 for about 2–3 GB of memory always on, at Railway's $10 per GB-month, plus CPU while checking; $50–150 for two replicas later (estimates) | **Now.** Same private network and bill as the other services. Railway has no GPUs |
| Hugging Face endpoint, CPU | from about $22 (1 vCPU / 2 GB, likely too small for a 421M-parameter model) | Similar cost; agent data goes to a third party |
| Hugging Face endpoint, T4 GPU | about $365 | Only when latency or volume need it; keep one replica always on |
| Scale to zero | $0 idle | Not for the live guard: after idling, a replica needs time to start and returns errors meanwhile. Fine for batch evaluation. |
| LLM for every check (no Laya) | about $3,700 at 1,000 agents | What Laya replaces |

Prices are from Hugging Face's pricing page on September 29, 2026. Latency is in [Speed](#speed): CPU is about 2.5 s per check.
