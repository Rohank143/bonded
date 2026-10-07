/**
 * Wording changes applied to the repo's docs on the way into the site, where a sentence only
 * makes sense next to the code (it names a file the reader can't open). The repo's own docs are
 * not touched. A patch whose text no longer matches is reported by the sync, not fatal.
 */
const at = (src, pairs) => pairs.map(([from, to]) => ({ src, from, to }));

export const PATCHES = [
  ...at("README.md", [
    [
      "and [contracts/solana/deployments](contracts/solana/deployments/devnet.json)",
      "and the [Solana program list](contracts/solana/deployments/devnet.json)",
    ],
    ["| | |\n|---|---|\n| **Web app**", "| What | Where |\n|---|---|\n| **Web app**"],
    [
      "| | |\n|---|---|\n| [ARCHITECTURE.md]",
      "| Page | What it covers |\n|---|---|\n| [ARCHITECTURE.md]",
    ],
    [
      "| [PLAN.md](docs/PLAN.md), [decisions/](docs/decisions/), [progress/](docs/progress/) | The plan, design decisions and daily notes |",
      "| [PLAN.md](docs/PLAN.md) | The product specification |",
    ],
    [
      "The same pages are published as a searchable site at `/docs` on the web app (built from these files by `apps/docs`; run it locally with `pnpm docs:dev`).\n",
      "",
    ],
  ]),

  ...at("docs/PLAN.md", [
    ["| | |\n|---|---|\n| **Event**", "| Item | Detail |\n|---|---|\n| **Event**"],
    [
      "| **Event** | Colosseum Crypto World's Fair (Sep 14 – Oct 12, 2026) |\n| **Tracks** | Robinhood Chain and Arbitrum (primary), Solana, Ethereum; also eligible for the overall top 21 |\n| **Team** | Human founder (product, review) + Claude (engineering) |\n| **Plan written** | Sat Sep 26, 2026 (Day 0) |\n| **Target submission** | Sun Oct 11, 2026 (one buffer day before the Oct 12 deadline; confirm the exact time zone on the submission page) |\n| **Status** | Planning complete. Build starts Day 1 |",
      "| **Chains** | Robinhood Chain and Arbitrum (primary), Solana, Ethereum |\n| **Team** | Human founder (product, review) + Claude (engineering) |\n| **Written** | Sat Sep 26, 2026 |",
    ],
    ["16. [Tech stack and repo layout](#16-tech-stack-and-repo-layout)\n", ""],
    ["20. [16-day build plan](#20-16-day-build-plan)\n", ""],
    ["21. [Demo script](#21-demo-script-3-minutes)\n", ""],
    ["22. [Submission checklist](#22-submission-checklist)\n", ""],
    ["24. [Action items for the founder](#24-action-items-for-the-founder)\n", ""],
    ["27. [Sources](#27-sources)\n", ""],
    [
      "As built on Day 2. Design choices and trade-offs are in `docs/decisions/002-mandate-vault.md`.",
      "As built on Day 2.",
    ],
    ["(deployed with `script/deploy.sh`)", "(deployed by Bonded's deploy script)"],
    ["### 14.3 SDK (`packages/sdk`, `@bonded/sdk`)", "### 14.3 SDK (`@bonded/sdk`)"],
    ["`script/Deploy.s.sol` deploys its own market", "The deploy script deploys its own market"],
    [
      "Addresses are written to `contracts/evm/deployments/<chainId>.json` and read through `parseEvmDeployment` in `@bonded/shared`. `script/Smoke.s.sol` runs the full loop against any deployment; `pnpm demo:local` runs both on anvil.",
      "Addresses are recorded in one deployment file per chain. A smoke script runs the full loop against any deployment; `pnpm demo:local` runs both on a local chain.",
    ],
    ["chain facts in `packages/shared/chains.ts`", "chain facts recorded in the shared package"],
    [
      "Addresses in `contracts/evm/deployments/`, read through `@bonded/shared`",
      "Addresses recorded per chain and read through `@bonded/shared`",
    ],
    [
      "evidence in `docs/progress/evidence/`",
      "evidence in the published [evidence file](docs/progress/evidence/demo-break-testnet.json)",
    ],
    [
      "read from `contracts/evm/deployments/` and the Solana deployment file",
      "read from the deployment files",
    ],
    [
      "the live rating of agent 10 is recorded in docs/progress/DAY-14.md",
      "the live rating of agent 10 is the one shown in the app",
    ],
    [
      "a short progress note in `docs/progress/DAY-XX.md` (done, next, blockers, review asks)",
      "a short progress note (done, next, blockers, review asks)",
    ],
  ]),

  ...at("docs/ARCHITECTURE.md", [
    [
      "Code: `contracts/evm/src/`; one-paragraph summaries in [contracts/evm/README.md](../contracts/evm/README.md).",
      "One-paragraph summaries of each contract are on the [smart contracts page](../contracts/evm/README.md).",
    ],
    ["; the maths is `packages/shared/src/actuarial.ts`)", ")"],
    [
      "The agents themselves are in `apps/demo-agents` ([AGENTS.md](AGENTS.md)).",
      "The agents themselves are described on the [agents page](AGENTS.md).",
    ],
  ]),

  ...at("docs/AGENTS.md", [
    [
      "Reports land in `apps/arena/ratings/<agent>/report.md`.",
      "Reports land in the Arena's `ratings/<agent>/report.md`.",
    ],
    [" (`apps/demo-agents/src/vulnerable/`)", ""],
    [" (`apps/demo-agents/src/hardened/`)", ""],
    [" (`hardened/guard.ts`)", ""],
    [
      'Code: `createPartialAgent` in `apps/demo-agents/src/index.ts` and `PolicyGuard({ matchAddressEnds: true })`; `--agent partial` in the Arena CLI; `kind: "partial"` in the API\'s agent config.',
      'It is selected with `--agent partial` in the Arena CLI and `kind: "partial"` in the API\'s agent config.',
    ],
    [
      "agents listed in `config/agents.46630.json` (see `docs/SERVICES.md`)",
      "agents listed in the operator config (see [the hosted services page](SERVICES.md))",
    ],
    ["(`apps/demo-agents/src/frameworks/`; the template", "(the template"],
  ]),

  ...at("contracts/evm/README.md", [
    [
      "This is the loop that [`script/Smoke.s.sol`](script/Smoke.s.sol) runs",
      "This is the loop that the smoke script runs",
    ],
    [
      "[`ChainlinkOracle`](src/oracles/ChainlinkOracle.sol) is the production price feed. It's in `src/` but isn't part of",
      "`ChainlinkOracle` is the production price feed. It isn't part of",
    ],
  ]),

  ...at("docs/BOUNTIES-EXPLAINED.md", [[" (`apps/arena/src/bounty.ts`)", ""]]),
  ...at("SECURITY.md", [
    [
      "Please report privately through GitHub: the repository's **Security** tab, then **Report a vulnerability**. Don't open a public issue for a vulnerability.",
      "Please report vulnerabilities privately to the maintainers. Don't open a public issue for a vulnerability.",
    ],
  ]),
  ...at("docs/BOUNTIES.md", [[" The rule is in `apps/arena/src/bounty.ts`.", ""]]),

  ...at("docs/DEVELOPING.md", [
    [
      "A deploy writes `contracts/evm/deployments/<chainId>.json` only after",
      "A deploy writes the chain's deployment file only after",
    ],
    [
      " Day 7 evidence and the Section 25 checklist: [docs/progress/DAY-07.md](progress/DAY-07.md).",
      "",
    ],
    [
      ", and [services/sentinel/kaggle/README.md](../services/sentinel/kaggle/README.md) walks through running Laya's own Kaggle notebook on it.",
      ".",
    ],
    [
      "Arena output goes to `apps/arena/traces/` and `apps/arena/ratings/<agent>/`;",
      "Arena output goes to the Arena's `traces/` and `ratings/<agent>/` folders;",
    ],
    [
      "the addresses are in [`contracts/evm/deployments/`](../contracts/evm/deployments/README.md)",
      "the addresses are on the [deployments page](../contracts/evm/deployments/README.md)",
    ],
    ["(see `apps/web/.env.example`)", "(see the web app's `.env.example`)"],
    ["in `apps/web/.env.local`", "in the web app's `.env.local`"],
    [
      " Library versions and the choice of RainbowKit are documented in [Wallet integration research](WALLET-INTEGRATION-RESEARCH.md).",
      "",
    ],
    [
      "`apps/arena/datasets/sentinel-synthetic.jsonl` (gitignored)",
      "`datasets/sentinel-synthetic.jsonl`",
    ],
    [" Results and limits of the first run: [docs/progress/DAY-08.md](progress/DAY-08.md).", ""],
  ]),

  ...at("docs/SERVICES.md", [
    ["Setup (founder action items 13 and 14 in `docs/PLAN.md`):", "Setup:"],
    [
      "is defined in `.railway/railway.ts`: the Dockerfile build",
      "is defined as code: the Dockerfile build",
    ],
    ["so the file leaves them out", "so the definition leaves them out"],
    [
      "the file marks them `preserve()` so their values never enter the repository",
      "the definition marks them as preserved so their values never enter source control",
    ],
    [
      "is generated by Railway and is not in the file",
      "is generated by Railway and is not part of the definition",
    ],
    [
      "it builds `services/sentinel/Dockerfile` (Laya's Python server, see `services/sentinel/README.md`)",
      "it builds the Sentinel service image (Laya's Python server)",
    ],
    [
      "`.railway/railway.ts` gives them `SENTINEL_URL`",
      "The service definition gives them `SENTINEL_URL`",
    ],
    ["build the root `Dockerfile`", "build the same Docker image"],
    ["load `config/agents.46630.json` (agent 2", "load an operator agents file (agent 2"],
    ["sets it in `.railway/railway.ts`", "sets it in its service definition"],
    [" The code is `apps/api/src/alerts.ts`.", ""],
    [
      "`.railway/railway.ts` lists both on `api` and `keeper` with `preserve()`, so an apply keeps their values.",
      "The service definition lists both on `api` and `keeper` as preserved values, so an apply keeps them.",
    ],
  ]),

  ...at("docs/TEE.md", [
    [
      "| Its image and compose file | `services/tee-agent/Dockerfile`, `docker-compose.yml` |",
      "| Its image and compose file | The TEE agent service's Dockerfile and `docker-compose.yml` |",
    ],
    [
      "| Verification in the Arena | `apps/arena/src/tee.ts`, `rate --tee-url` |",
      "| Verification in the Arena | The Arena's TEE check, `rate --tee-url` |",
    ],
    [
      "| The badge | `apps/web/src/pages/Agent.tsx` |",
      "| The badge | The agent page in the web app |",
    ],
    [
      "Put it in `services/tee-agent/docker-compose.yml`, replacing",
      "Put it in the service's `docker-compose.yml`, replacing",
    ],
    [
      "the entry goes into `config/agents.46630.json` through a pull request",
      "the entry goes into the operator agents file through a pull request",
    ],
    [
      "a single constant in `packages/shared/src/actuarial.ts`",
      "a single constant in the shared scoring code",
    ],
  ]),

  ...at("docs/SENTINEL.md", [
    [
      "Details are in plan Section 10, the Kaggle guide (`services/sentinel/kaggle/README.md`) and `docs/BUSINESS.md`.",
      "Details are in plan Section 10 and `docs/BUSINESS.md`.",
    ],
    [" in `apps/api/src/sentinel.ts`)", ")"],
  ]),

  ...at("docs/SENTINEL-STRESS.md", [
    ["(`docs/progress/DAY-10.md`, gate 2)", "(gate 2)"],
    ["`apps/arena/src/stress.ts` builds 516", "The stress suite builds 516"],
    [" (`contrast.ts`)", ""],
    [" (`llm-contrast.ts`)", ""],
    [" (`check_tokens.py`)", ""],
    [
      "the rules are in `apps/arena/src/gates.ts`, and the verdict",
      "the rules are part of the gate runner, and the verdict",
    ],
    ["(`apps/arena/src/shortcuts.ts`, `pnpm", "(`pnpm"],
    ["**New data** (`apps/arena/src/contrast.ts`):", "**New data**:"],
    [
      "The approved-spender rule is new in `stress.ts` (`approveTo`).",
      "The approved-spender rule (`approveTo`) is new in the stress suite.",
    ],
    [" (`gates.ts`)", ""],
    [' Build steps are in `services/sentinel/kaggle/README.md`, "v4".', ""],
    [" (`dataset.ts`)", ""],
    ["(`dataset.ts`, `plantedOrders`)", "(`plantedOrders`)"],
    ["(`rewrite.ts`, `pnpm", "(`pnpm"],
    ["(`consistency.ts`, `pnpm", "(`pnpm"],
    [
      "`scripts/sentinel-gates.sh` runs it, and the verdict includes it.",
      "The gate runner runs it, and the verdict includes it.",
    ],
    [
      "`services/sentinel/kaggle/filter_giveaways.py` does both: the rounds, or `--all`.",
      "The filter script does both: the rounds, or `--all`.",
    ],
    ["`.railway/railway.ts` pins v5.", "The production service pins v5."],
  ]),

  ...at("docs/AUDIT.md", [
    [
      "the testnet deployments in `contracts/evm/deployments/` were not changed",
      "the testnet deployments were not changed",
    ],
    ["`contracts/evm/test/invariant/mutations.py` plants", "A mutation script plants"],
  ]),

  ...at("contracts/evm/deployments/README.md", [
    ["validated by `packages/shared/test/deployments.test.ts`", "validated by a test"],
    ["**`RecordDeployment.s.sol`** runs only if", "**The record step** runs only if"],
  ]),
];
