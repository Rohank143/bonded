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
phala deploy --name bonded-tee-agent --compose services/tee-agent/docker-compose.yml --instance-type tdx.small --no-dev-os --wait
```

**Always pass `--no-dev-os`.** The CLI finds your SSH key and otherwise deploys a dev OS image, which allows SSH into the VM, so the operator could read the agent's keys. `phala cvms get <name>` must show `Dstack: dstack-0.5.9` without `dev`. The Arena does not reject dev images yet, so this is on you.

The instance costs $0.058 an hour (`tdx.small`). Your Phala balance must be above zero first.

Find the app's URL with `phala cvms get <name> --json` (the `endpoints` entry, `https://<app-id>-8080.<gateway>`). Check it:

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

`phala cvms get <name> --json` has a `compose_file` field. Save it as a file and pass that file. The tool drops the null fields and empty `init_script` that Phala's API adds, so the hash is the one the hardware measures. The value must also equal the `compose_hash` Phala reports and the `composeHash` in `curl <url>/attestation?nonce=0x<64 hex>` and the compose hash Phala shows for the app. If they differ, stop.

**5. Rate with the TEE.** From the repository root:

```bash
pnpm arena rate --agent hardened --enforce --code-hash 0x<code hash> --tee-url https://<that-url> --tee-compose-hash 0x<compose hash>
```

The Arena sends a random challenge, verifies the quote with Intel's collateral, and prints `TEE verified: measurement 0x…`. The attestation carries it, and the report has a TEE line. Any failure stops the rating and says why.

**6. What the first real deployment showed.** The Arena has been run against a real deployment (2026-10-02, dstack 0.5.9). Two things differed from the spec I started from, both fixed: the guest agent leaves `digest` empty for runtime events, so the Arena computes it, and Phala's API shows the manifest with extra null fields. A real quote, with its event log, is saved as a test fixture (`apps/arena/test/fixtures/tee-live.json`).

**7. Bind a vault to the TEE's key, then make it live.** The TEE proves its own key. For the score's TEE discount to apply, the vault being insured must be run by that key:

- the vault's execution key (`vault.agent()`) must equal the `evmAddress` from `curl <url>/health`. The vault's guardian sets it with `rotateAgent(address)`, or you create a new vault with that address as the agent (`MandateVaultFactory.createVault`);
- the API refuses new cover for an agent with a TEE measurement unless that holds (ADR-013, decision 3).

**Do not do this to agent 2.** It is the Gate 1 demo vault, and rotating its key would break its scripted live flow. Use a separate demo agent and vault for TEE custody.

The TEE service doesn't operate a vault yet (it has no route that sends transactions), so a TEE-bound vault can be quoted and rated but is not traded by the TEE. ADR-012 and ADR-014 say so.

Then put the TEE in that agent's service config (`config/agents.46630.json`), so API rating jobs verify it:

```json
{ "kind": "hardened", "codeHash": "0x…", "mandate": { "…": "…" }, "tee": { "url": "https://<that-url>", "composeHash": "0x…" } }
```

Run a rating through the API with `scripts/rate-live-tee.sh <agent id>`: it asks for the API token with no echo and never puts it in a process argument, starts the VM, runs the rating, prints the result and **always stops the VM when it ends**, so the VM bills only while the rating runs. It works only after this code is merged and the API has redeployed. When the score is posted, the agent's page shows the TEE badge.

## What the TEE does to the price (ADR-014)

A rating now includes a key-custody term. It is an assumption, not a measurement: it assumes a 2% a year chance that an agent's server is compromised. An operator-held key is assumed stolen in that case, and a key in a verified TEE is assumed safe. So the same agent rates a little better in a verified TEE: 96 and a 1.22% premium, against 93 and 1.48% on an operator's server (hardened demo agent, Enforce mode, 5 runs per seed). The effect scales with that 2%, a single constant in `packages/shared/src/actuarial.ts`.

## Live checks (ADR-013)

The keeper challenges every agent that has a `tee` entry every ten minutes (`TEE_CHECK_MS`, default 600000) and compares the live measurement with the one in its on-chain score. The profile shows the result as "TEE live check".

- **Offline** (grey): the VM is stopped or not answering. Nothing is blocked because of it. A stopped VM is not a broken one, and it can't leak a key.
- **Changed** or **failed** (red): the running TEE is not the one that was rated, or its proof doesn't verify. The API stops signing new cover quotes for that agent until a check passes again or the agent is re-rated. An outage doesn't clear it. Cover already bound is not touched.

## Cost, and pausing it

- `tdx.small` is Phala's smallest instance: $0.058 an hour for compute plus $0.0028 an hour for its 20 GB disk, about $44 a month running.
- Billing is per minute. **Stopping** the VM stops the compute charge at once. Only the disk is charged (about $2 a month), and the disk is kept.
- **Stop it when you aren't using it, start it when you need it:**

```bash
phala cvms stop bonded-tee-agent
```

```bash
phala cvms start bonded-tee-agent
```

- Tested on 2026-10-02: after a stop and start the app has the same URL, the same session keys and the same measurement, and its quote verifies again. Allow a couple of minutes after `start` before rating.
- While it is stopped, API rating jobs for an agent with a TEE entry fail by design (no unmeasured score). Start it before running one, or use the script.
- **Deleting** it stops the disk charge too, but a new deployment gets a new app id, so a new URL and new keys. Update the agent's `tee` entry and re-rate.
- Phala's pricing page mentions $20 of free credit for CVM usage after account verification. Check whether your account has it.

## Things to know

- **Re-deploying changes the answer.** A new image digest means a new compose hash and a new measurement, so every re-deploy needs a new rating. That is the point: the score belongs to one exact deployment.
- **Phala's OS image counts.** If Phala upgrades the host OS image under your app, MRTD and the RTMRs change and the measurement changes with them.
- **Out-of-date platforms are refused.** Only Intel TCB statuses `UpToDate` and `SWHardeningNeeded` pass.
- **The simulator.** dstack's simulator uses a fixed development key, so the Arena refuses its quotes. Use it for development of the service, not for ratings.
