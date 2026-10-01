# TEE custody: the founder's runbook

Plain-language version of ADR-012: the hardened agent can run inside a Phala Cloud confidential VM. The VM's hardware vouches for which code is running, and the agent's keys are made inside it. The Arena checks that proof and puts a measurement in the score, and the agent profile shows a "TEE" badge.

Everything below that needs your Phala account is a step for you. Nothing here puts a secret in the repository.

## What is in the repository

| Piece | Where |
|---|---|
| The service that runs in the VM | `services/tee-agent/` |
| Its image and compose file | `services/tee-agent/Dockerfile`, `docker-compose.yml` |
| Verification in the Arena | `apps/arena/src/tee.ts`, `rate --tee-url` |
| The badge | `apps/web/src/pages/Agent.tsx` |

The service has two routes: `GET /health` and `GET /attestation?nonce=<32 bytes hex>`. It has no route that signs or returns a key.

## Try it locally (no hardware)

```bash
docker compose -f services/tee-agent/docker-compose.local.yml up --build
```

```bash
curl localhost:8080/health
```

This runs with `TEE_BACKEND=mock`. The answer looks right, but the "quote" is not a TDX quote, so the Arena refuses it. This only checks the wiring.

## Deploy to Phala Cloud

You need the `phala` CLI logged in to your account (`phala login`) and a registry the VM can pull from. These steps use GitHub Container Registry; the image must be public or you must give Phala pull access.

**1. Pick the code hash.** It is the `codeHash` you give the Arena when rating the hardened agent (`--code-hash`, or `codeHash` in the agent's config). Use the same value everywhere.

**2. Build and push the image, then pin it.** From the repository root:

```bash
docker build --platform linux/amd64 -f services/tee-agent/Dockerfile --build-arg CODE_HASH=0x<64 hex digits> -t ghcr.io/ddboy19912/bonded-tee-agent:day-11 .
```

```bash
docker push ghcr.io/ddboy19912/bonded-tee-agent:day-11
```

Phala Cloud runs x86 machines, so the image must be built for `linux/amd64` (an Apple Silicon Mac builds ARM images by default, and those fail to start). `docker push` prints a `sha256:` digest. Put it in `services/tee-agent/docker-compose.yml`, replacing `REPLACE_WITH_DIGEST`. Always pin the digest. A tag can be moved, and the digest is what the hardware measures.

**3. Deploy.**

```bash
phala deploy --name bonded-tee-agent --compose services/tee-agent/docker-compose.yml
```

Phala prints the app's URL (a `https://<app-id>-8080.<gateway>` address). Check it:

```bash
curl https://<that-url>/health
```

`backend` must say `dstack`. It prints the agent's two public keys.

**4. Get the compose hash, and check it yourself.** Download the app-compose manifest Phala built from your file (the app's Attestations page in the Phala dashboard shows it, and `phala runtime-config <name>` prints the runtime configuration), then compute its hash locally. Do not copy the hash from the agent's own answer: that is the thing being checked.

```bash
pnpm --filter @bonded/tee-agent build
```

```bash
pnpm --filter @bonded/tee-agent compose-hash path/to/app-compose.json
```

The value must also equal the `composeHash` in `curl <url>/attestation?nonce=0x<64 hex>` and the compose hash Phala shows for the app. If they differ, stop.

**5. Rate with the TEE.** From the repository root:

```bash
pnpm arena rate --agent hardened --enforce --code-hash 0x<code hash> --tee-url https://<that-url> --tee-compose-hash 0x<compose hash>
```

The Arena sends a random challenge, verifies the quote with Intel's collateral, and prints `TEE verified: measurement 0x…`. The attestation carries it, and the report has a TEE line. Any failure stops the rating and says why.

**6. First deployment only: confirm the event digest rule.** The Arena recomputes the compose-hash event's digest (ADR-012, "Not done"). If step 5 fails with "the compose-hash event does not match its digest", that rule differs from what dstack records. Send me the full `/attestation` output and the error; it's a one-line fix, and the tests need the real event for a fixture.

**7. Make it live.** Put the TEE in the agent's service config, so API rating jobs verify it too:

```json
{ "kind": "hardened", "codeHash": "0x…", "mandate": { "…": "…" }, "tee": { "url": "https://<that-url>", "composeHash": "0x…" } }
```

Then run a rating through the API (`POST /arena/runs`). When the score is posted, the agent's page shows the TEE badge. Cross-chain posting copies the measurement to the other chains' registries.

## Things to know

- **Re-deploying changes the answer.** A new image digest means a new compose hash and a new measurement, so every re-deploy needs a new rating. That is the point: the score belongs to one exact deployment.
- **Phala's OS image counts.** If Phala upgrades the host OS image under your app, MRTD and the RTMRs change and the measurement changes with them.
- **Out-of-date platforms are refused.** Only Intel TCB statuses `UpToDate` and `SWHardeningNeeded` pass.
- **The simulator.** dstack's simulator uses a fixed development key, so the Arena refuses its quotes. Use it for development of the service, not for ratings.
