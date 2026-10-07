/**
 * Wording changes applied to the repo's docs on the way into the site, where a sentence points
 * at a doc the site doesn't carry (decision records, build log, wallet research) or at a table
 * or section that was left out. The repo's own docs are not touched. A patch whose text no
 * longer matches is reported by the sync, not fatal.
 */
const at = (src, pairs) => pairs.map(([from, to]) => ({ src, from, to }));

export const PATCHES = [
  ...at("README.md", [
    ["| [SERVICES.md](docs/SERVICES.md) | The hosted API, keeper and workers; alerts |\n", ""],
    [
      "The same pages are published as a searchable site at `/docs` on the web app (built from these files by `apps/docs`; run it locally with `pnpm docs:dev`).\n",
      "",
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
      "| `docs/` | Plan, architecture, decisions, audit, progress notes |",
      "| `docs/` | The documentation: specification, architecture, audit and more |",
    ],
  ]),

  ...at("docs/PLAN.md", [
    ["| | |\n|---|---|\n| **Event**", "| Item | Detail |\n|---|---|\n| **Event**"],
    [
      "| **Event** | Colosseum Crypto World's Fair (Sep 14 – Oct 12, 2026) |\n| **Tracks** | Robinhood Chain and Arbitrum (primary), Solana, Ethereum; also eligible for the overall top 21 |\n| **Team** | Human founder (product, review) + Claude (engineering) |\n| **Plan written** | Sat Sep 26, 2026 (Day 0) |\n| **Target submission** | Sun Oct 11, 2026 (one buffer day before the Oct 12 deadline; confirm the exact time zone on the submission page) |\n| **Status** | Planning complete. Build starts Day 1 |",
      "| **Chains** | Robinhood Chain and Arbitrum (primary), Solana, Ethereum |\n| **Team** | Human founder (product, review) + Claude (engineering) |\n| **Written** | Sat Sep 26, 2026 |",
    ],
    ["20. [16-day build plan](#20-16-day-build-plan)\n", ""],
    ["21. [Demo script](#21-demo-script-3-minutes)\n", ""],
    ["22. [Submission checklist](#22-submission-checklist)\n", ""],
    ["24. [Action items for the founder](#24-action-items-for-the-founder)\n", ""],
    ["27. [Sources](#27-sources)\n", ""],
    [
      "As built on Day 2. Design choices and trade-offs are in `docs/decisions/002-mandate-vault.md`.",
      "As built on Day 2.",
    ],
    [
      "evidence in `docs/progress/evidence/`",
      "evidence in the published [evidence file](docs/progress/evidence/demo-break-testnet.json)",
    ],
    [
      "a short progress note in `docs/progress/DAY-XX.md` (done, next, blockers, review asks)",
      "a short progress note (done, next, blockers, review asks)",
    ],
    [
      "the live rating of agent 10 is recorded in docs/progress/DAY-14.md",
      "the live rating of agent 10 is the one shown in the app",
    ],
  ]),

  ...at("docs/ARCHITECTURE.md", [
    [
      "One Docker image, three roles on Railway ([SERVICES.md](SERVICES.md), [ADR-008](decisions/008-hosting-and-storage.md)), sharing Postgres:",
      "Three off-chain services share one database:",
    ],
  ]),

  ...at("docs/AUDIT.md", [
    ["**Status: fixed** (this branch, `static-analysis`).", "**Status: fixed.**"],
  ]),

  ...at("docs/TEE.md", [
    ["Plain-language version of ADR-012: the hardened agent", "The hardened agent"],
    [" ADR-012 and ADR-014 say so.", ""],
  ]),

  ...at("contracts/evm/README.md", [
    [
      " For the reasoning behind each design choice, see the decision records linked at the end.",
      "",
    ],
  ]),

  ...at("docs/AGENTS.md", [
    [
      "On the hosted services, the arena worker rates the agents listed in `config/agents.46630.json` (see `docs/SERVICES.md`); accepted bounty attacks",
      "Accepted bounty attacks",
    ],
  ]),

  ...at("docs/DEVELOPING.md", [
    ["Long-running service setup and API requests: [docs/SERVICES.md](SERVICES.md).", ""],
    [
      " Day 7 evidence and the Section 25 checklist: [docs/progress/DAY-07.md](progress/DAY-07.md).",
      "",
    ],
    [
      " Library versions and the choice of RainbowKit are documented in [Wallet integration research](WALLET-INTEGRATION-RESEARCH.md).",
      "",
    ],
    [" Results and limits of the first run: [docs/progress/DAY-08.md](progress/DAY-08.md).", ""],
  ]),

  ...at("docs/ARCHITECTURE.md", [
    [
      " Sections 5–14 and the decision records in [decisions/](decisions/); this page is the map.",
      " Sections 5–14; this page is the map.",
    ],
  ]),

  ...at("docs/SERVICES.md", [
    ["Setup (founder action items 13 and 14 in `docs/PLAN.md`):", "Setup:"],
  ]),

  ...at("docs/SENTINEL-STRESS.md", [["(`docs/progress/DAY-10.md`, gate 2)", "(gate 2)"]]),
];
