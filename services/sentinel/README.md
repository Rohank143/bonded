# Sentinel service

Laya's own HTTP server (`laya.serve`, pinned `laya[serve]==0.3.21`) serving Bonded's fine-tuned Sentinel checkpoint. The protocol, bearer check and health probe are Laya's. `server.py` only chooses the weights and binds a socket that accepts IPv6 and IPv4. Plain-language overview: [docs/SENTINEL.md](../../docs/SENTINEL.md). Training: [kaggle/README.md](kaggle/README.md).

## API

- `GET /health`: status, loaded checkpoint and revision, and whether it computes on CPU or GPU.
- `POST /v1/systemone`: `{"state": …, "questions": …, "model": "typed-decisions"}` with `Authorization: Bearer <LAYA_API_KEY>`. Returns one typed answer with probabilities for each question.

Callers don't build requests by hand. `LayaSentinel` in `@bonded/demo-agents` sends the exact state and questions the model trained on (`sentinelState` and `sentinelQuestions` in `@bondedhq/shared`).

## Configuration

| Variable | Meaning |
|---|---|
| `SENTINEL_MODEL_REPO` | The fine-tune's Hugging Face repo, e.g. `<user>/bonded-sentinel-laya`. Unset, it serves Laya's published base checkpoint, which is for testing the service only and is not Sentinel. |
| `SENTINEL_MODEL_REVISION` | The repo commit to serve. Pin it. |
| `HF_TOKEN` | A Hugging Face **read** token for the private repo. |
| `LAYA_API_KEY` | The bearer token callers must send. |
| `PORT` | The listening port (Railway sets it). |
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

Railway has no GPUs, so Sentinel runs there on CPU: see the latency table in `docs/SENTINEL.md`. The container uses a little over 2 GB of memory after loading and more while checking; give it 4 GB and read the real peak from Railway's metrics. For production speed you need a GPU host, and the image as built won't use one: it installs CPU-only PyTorch, and `LAYA_DEVICE` defaults to `cpu` (Laya also falls back to CPU when the requested GPU is missing). Build a CUDA-enabled image (a CUDA build of PyTorch in the Dockerfile), set `LAYA_DEVICE=cuda`, and point the API and worker at the new Sentinel URL.
