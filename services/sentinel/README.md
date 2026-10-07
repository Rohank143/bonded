# Sentinel service

Laya's own HTTP server (`laya.serve`, pinned `laya[serve]==0.3.21`) serving Bonded's fine-tuned Sentinel checkpoint. The protocol, bearer check and health probe are Laya's. `server.py` only chooses the weights and binds a socket that accepts IPv6 and IPv4. Plain-language overview: [docs/SENTINEL.md](../../docs/SENTINEL.md).

## API

- `GET /health`: status, loaded checkpoint and revision, and whether it computes on CPU or GPU.
- `POST /v1/systemone`: `{"state": …, "questions": …, "model": "typed-decisions"}` with `Authorization: Bearer <LAYA_API_KEY>`. Returns one typed answer with probabilities for each question.

Callers don't build requests by hand. `LayaSentinel` in `@bonded/demo-agents` sends the exact state and questions the model trained on (`sentinelState` and `sentinelQuestions` in `@bonded/shared`).

## Configuration

| Variable | Meaning |
|---|---|
| `SENTINEL_MODEL_REPO` | The fine-tune's model repo. Unset, it serves Laya's published base checkpoint, which is for testing the service only and is not Sentinel. |
| `SENTINEL_MODEL_REVISION` | The repo commit to serve. Pin it. |
| `HF_TOKEN` | A Hugging Face **read** token for the model repo. |
| `LAYA_API_KEY` | The bearer token callers must send. |
| `PORT` | The listening port (set by the host). |
| `LAYA_THREADS` | Number of CPU threads; match the service's vCPUs. |

## Run locally

```bash
docker build -t bonded-sentinel services/sentinel
```

```bash
docker run --rm -p 8000:8000 -e LAYA_API_KEY=dev-key -e LAYA_THREADS=2 bonded-sentinel
```

Then check it with the opt-in adapter test and score it on held-out episodes:

```bash
LAYA_URL=http://127.0.0.1:8000 LAYA_API_KEY=dev-key pnpm --filter @bonded/demo-agents test
```

```bash
LAYA_API_KEY=dev-key pnpm sentinel:eval --arena ratings/heldout-vulnerable/sentinel-dataset.jsonl --arena ratings/heldout-hardened/sentinel-dataset.jsonl --laya http://127.0.0.1:8000
```

The model downloads when the container starts, which takes a few minutes the first time. Mount a cache at `/app/.cache/huggingface` to keep it between runs.

## Hosting

Sentinel runs as a container on CPU or GPU hosts. The image as built installs CPU-only PyTorch and `LAYA_DEVICE` defaults to `cpu`; for a GPU host, build a CUDA-enabled image and set `LAYA_DEVICE=cuda`. See the latency table in `docs/SENTINEL.md`.
