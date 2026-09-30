"""Bonded Sentinel: Laya's own HTTP server, serving our fine-tuned checkpoint.

It uses Laya's stock `/v1/systemone` protocol, bearer check and health probe
(`laya.serve.create_app`). The only change is which weights answer: the router's
`typed-decisions` slot loads `SENTINEL_MODEL_REPO` at `SENTINEL_MODEL_REVISION`
instead of Laya's published checkpoint. See docs/SENTINEL.md.

Environment:
  SENTINEL_MODEL_REPO      Hugging Face repo of the fine-tune, e.g. "<user>/bonded-sentinel-laya".
                           Unset: Laya's published typed-decisions checkpoint (base model, for
                           testing the service only; it is not Sentinel).
  SENTINEL_MODEL_REVISION  commit to pin (recommended); unset uses the latest.
  HF_TOKEN                 read token for a private repo.
  LAYA_API_KEY             bearer token callers must send (set it on Railway).
  PORT                     listening port (Railway sets it); falls back to LAYA_PORT or 8000.
  The server listens on IPv6 and IPv4 at once: Railway's private network is IPv6, while
  Docker port forwarding and most local tools use IPv4.
  LAYA_THREADS, LAYA_DEVICE, LAYA_MAX_CONCURRENT: as in laya.serve.
"""

import os
import socket

import uvicorn
from laya.router import DEFAULT_MODELS, Router
from laya.serve import _apply_thread_limit, create_app

BASE_REVISION = "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851"


def build_router() -> Router:
    _apply_thread_limit()
    repo = os.environ.get("SENTINEL_MODEL_REPO", "").strip()
    if repo:
        models = {"typed-decisions": (repo, None)}
        revision = os.environ.get("SENTINEL_MODEL_REVISION", "").strip() or None
        print(f"Sentinel: serving {repo} at {revision or 'latest'}", flush=True)
    else:
        models = {"typed-decisions": DEFAULT_MODELS["typed-decisions"]}
        revision = BASE_REVISION
        print("Sentinel: SENTINEL_MODEL_REPO unset; serving base Laya (not the fine-tune)", flush=True)
    router = Router(
        models=models,
        revisions={"typed-decisions": revision} if revision else None,
        device=os.environ.get("LAYA_DEVICE", "cpu").strip() or None,
        token=os.environ.get("HF_TOKEN") or None,
        default="typed-decisions",
        max_loaded=1,
    )
    router.preload(["typed-decisions"])
    return router


def dual_stack_socket(port: int) -> socket.socket:
    """One socket for IPv6 and IPv4. Binding "::" through asyncio would be IPv6-only (it sets
    IPV6_V6ONLY), which breaks IPv4 clients such as Docker's port forwarding."""
    sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
    sock.bind(("::", port))
    return sock


def main() -> None:
    port = int(os.environ.get("PORT") or os.environ.get("LAYA_PORT") or "8000")
    sock = dual_stack_socket(port)
    print(f"Sentinel: listening on port {port} (IPv6 and IPv4)", flush=True)
    uvicorn.run(create_app(build_router()), fd=sock.fileno())


if __name__ == "__main__":
    main()
