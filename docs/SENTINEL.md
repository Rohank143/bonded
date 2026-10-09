# Sentinel: how it works, end to end

Sentinel is Bonded's real-time guard: a fine-tuned Laya model that checks each trade an agent proposes before it runs. This page explains how it works, how to use it and how fast it is.

## The flow

**1. Make training data.** Arena attacks and synthetic examples become labelled questions, such as "is this action manipulated?". `pnpm sentinel:synth` writes the synthetic examples and `pnpm sentinel:dataset` builds the training files. Some attack classes are held out of training so they can test it later.

**2. Fine-tune.** Fine-tune Laya on the files and pin the resulting checkpoint.

**3. Serve it.** It runs as a small service next to the API. Agent data stays inside Bonded's infrastructure. It runs on CPU at about 2.5 s per check (see [Speed](#speed)), and faster on a GPU.

**4. Check every trade.** Before an agent's trade goes through:

```
agent wants to trade → Sentinel checks it (about 2.5 s on CPU, under 300 ms on an NVIDIA T4 GPU)
   ├─ looks fine        → trade goes ahead
   ├─ looks manipulated → trade blocked, vault owner alerted
   └─ unsure, or calls it a likely breach → a cheap LLM double-checks
```

**5. Prove it works.** Test it on real episodes from attack classes it never saw, then re-rate agents with Sentinel on. If breaches drop, premiums drop: the discount is earned, not asserted.

**Stress-test it.** `pnpm sentinel:stress` scores a model on 528 disguised cases in 44 families, with rule-checked labels and locked test-only variants. The weakness map for v1 and v2, and what v3 must fix, is in [SENTINEL-STRESS.md](SENTINEL-STRESS.md).

**Questions per version.** v1 and v2 answer three questions. v3 answers two, manipulated and injection in inputs, and code decides "within the mandate or breach" with the policy guard's exact check; "suspicious" is derived as manipulated and within the rules (`SentinelQuestionSet` in `@bondedhq/shared`, and [SENTINEL-STRESS.md](SENTINEL-STRESS.md) for why).

**6. Keep it fresh.** When new attacks appear, add them to the data and retrain. A new model goes live only if it scores at least as well as the old one.

**What blocks.** Only "manipulated" blocks a trade. Sentinel also answers "is this a likely breach?", but the vault already enforces the mandate on chain, so that answer is a label and a reason for the LLM double-check, not a block.

**Safety rule.** Sentinel only advises and blocks suspicious trades. Payouts are decided by the vault's on-chain breach log, so a wrong Sentinel answer can never cause a wrongful payout.

## Using Sentinel

Three ways in, all on the v5 model with the v3 question set and a 0.7 block threshold (`SENTINEL_SERVING` in `@bondedhq/shared`):

- **The Sentinel page** (`/sentinel` in the web app) says whether it's running, how v5 was tested, and how to use it.
- **Rate with Sentinel on.** When onboarding, an owner can tick "Rate it with Sentinel in front"; the registration message then carries a `sentinel on` line. An operator config sets `"sentinel": true`. The worker runs every rating episode with Sentinel in front of the agent (`ratedAgent` in `apps/api/src/sentinel.ts`). The report records `sentinel: { model, questions, blockThreshold }` and the checkpoint, and the agent page and the PDF say "Sentinel on". A config's `codeHash` is always the agent's own code; with Sentinel on the worker attests a combined hash (`ratedCodeHash`), for operator configs and self-serve alike, so the score is never passed off as the agent's alone. Sentinel with a TEE agent is refused for now: the TEE attests the agent's own code hash. If the agent breaches less, it scores higher and its premium falls: the discount is measured, not assumed. A Sentinel-on rating is never attested without Sentinel actually answering: it fails without `SENTINEL_URL`, and any check that got no answer (the service down, a bad key, a malformed reply) is counted in the report as `guardFailures`, which makes the rating incomplete. The guard still refuses the write in that case, so the agent stays safe.
- **Ask before each trade.** `POST /sentinel/check` takes the mandate, the proposed action and what the agent read, signed with the agent's own key over `sentinelCheckMessage` and `sentinelCheckDigest` from `@bondedhq/shared`. The key is the vault's current `agent()`, read on every check, so a key the guardian rotates out stops working at once. It answers `{ blocked, manipulated, injection, blockThreshold, model, latencyMs }`, or an error (429 throttled, 503 busy or no answer): treat anything but a clear `blocked: false` as "don't trade". Limits: 30 checks a minute per agent, 4 running at once, 20 s each, and a 256 KB body (the most its fields allow). Only the outcome is stored (`sentinel_checks`: agent, time, manipulated probability, blocked); the action and inputs never are. Agent pages show the last 7 days' counts. `GET /sentinel` reports `configured` and `available`: available means its health probe passes (checked at most every 30 s) and no check has gone unanswered in the last 2 minutes.

The answer is advice: the agent decides whether to go ahead, and the vault enforces the mandate either way. On CPU a check takes about 2.5 s, fine for agents that trade minutes apart.

## Keeping it current

Sentinel only knows the attacks it has seen, so it is retrained when new attack classes or variants appear (from bounties or incidents), when it misses a breach or raises false alarms, and when its confidence drifts on recent labelled rows. A new base model is adopted only if it measures better on the held-out evaluation.

Every retrain must:
- pass the held-out evaluation;
- keep the previous model for rollback;
- trigger an Arena re-run, because Sentinel changes premiums.

When a held-out class has to join training, new held-out classes are chosen first, or the evaluation stops being honest.

## Speed

One check is one forward pass over the mandate, the proposed action and the untrusted inputs (about 500 to 700 tokens on Arena episodes). Measured with base Laya, which has the same size and speed as the fine-tune:

| Where | Conditions | Per check | Source |
|---|---|---|---|
| CPU | Apple M-series laptop, PyTorch, 2 threads, real held-out states | 2.3–2.9 s (p50 about 2.6 s); 4 or 8 threads are no faster | Measured |
| GPU | Apple M-series laptop GPU (MPS), 111 held-out cases | p50 684 ms, p95 731 ms | Measured |
| GPU | NVIDIA T4, fine-tuned model, our 24 test rows | p50 217 ms, p95 228 ms | Measured |
| GPU | NVIDIA T4, the author's benchmark | about 33 ms per forward pass | Laya's README, not ours |

So Sentinel takes **under 300 ms per check on a T4 GPU** and **about 2.5 s on CPU**. The author's 33 ms is one forward pass on a short input; our check answers three questions about a 500 to 700 token state.

What this means: 2.5 s is acceptable for agents that trade minutes apart, since the check runs once before each trade. It is too slow for high-frequency agents. The cascade adds an LLM call only for unsure cases.

Memory: the model needs about 2 GB.
