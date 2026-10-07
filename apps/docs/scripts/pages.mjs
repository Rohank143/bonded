/**
 * Which repository documents become pages, and where. The repo's Markdown stays the single
 * source: the site is generated from it, so the two cannot drift.
 *
 * `src` is relative to the repository root; `slug` is the page's path under /docs/.
 */
export const PAGES = [
  { src: "README.md", slug: "overview/introduction", label: "Introduction", title: "Introduction" },
  { src: "docs/PLAN.md", slug: "overview/plan", label: "Product and build plan" },
  { src: "docs/BUSINESS.md", slug: "overview/business", label: "Business model and costs" },

  { src: "docs/ARCHITECTURE.md", slug: "concepts/architecture", label: "Architecture" },
  { src: "docs/AGENTS.md", slug: "concepts/agents", label: "Agents" },
  { src: "contracts/evm/README.md", slug: "concepts/contracts", label: "Smart contracts" },
  {
    src: "docs/BOUNTIES-EXPLAINED.md",
    slug: "concepts/bounties-explained",
    label: "How bounties work",
  },

  { src: "docs/DEVELOPING.md", slug: "guides/developing", label: "Developing Bonded" },
  {
    src: "docs/SERVICES.md",
    slug: "guides/services",
    label: "Hosted services",
    title: "Hosted services",
  },
  { src: "docs/BOUNTIES.md", slug: "guides/bounties", label: "Submit a bounty attack" },
  { src: "docs/TEE.md", slug: "guides/tee", label: "TEE custody runbook" },

  { src: "docs/SENTINEL.md", slug: "sentinel/overview", label: "How Sentinel works" },
  { src: "docs/SENTINEL-STRESS.md", slug: "sentinel/stress-suite", label: "Stress suite" },

  {
    src: "SECURITY.md",
    slug: "security/policy",
    label: "Security policy",
    title: "Security policy",
  },
  { src: "docs/AUDIT.md", slug: "security/audit", label: "Internal audit note" },
  { src: "docs/disclosures/README.md", slug: "security/disclosures", label: "Disclosure policy" },
  {
    src: "docs/disclosures/agentkit-langchain-chatbot.md",
    slug: "security/disclosures/agentkit-langchain-chatbot",
    label: "Coinbase AgentKit",
  },
  {
    src: "docs/disclosures/solana-agent-kit-langgraph.md",
    slug: "security/disclosures/solana-agent-kit-langgraph",
    label: "Solana Agent Kit",
  },

  {
    src: "contracts/evm/deployments/README.md",
    slug: "reference/deployments",
    label: "Deployments",
  },
  {
    src: "docs/WALLET-INTEGRATION-RESEARCH.md",
    slug: "research/wallet-integration",
    label: "Wallet integration research",
  },
];

/** Folders whose Markdown files each become a page, in file-name order. */
export const FOLDERS = [
  {
    dir: "docs/decisions",
    slug: "decisions",
    index: {
      title: "Decision records",
      description: "Every design decision behind Bonded, written down when it was made.",
      intro:
        "Each record states the context, the decision and what it costs. They are numbered in the order they were made.",
    },
    name: (file) => file.replace(/\.md$/, ""),
  },
  {
    dir: "docs/progress",
    slug: "progress",
    index: {
      title: "Build log",
      description:
        "Daily notes from the 16-day build: what shipped, what was measured, what is open.",
      intro:
        "One note per build day, in order. Each links to the plan section it delivers and the evidence behind its numbers.",
    },
    name: (file) => file.replace(/\.md$/, "").toLowerCase(),
  },
];

/** Where evidence files live on the site. Linked from the notes that cite them. */
export const EVIDENCE_DIRS = [
  { from: "docs/progress/evidence", to: "evidence" },
  { from: "contracts/evm/deployments", to: "evidence/deployments", only: /\.json$/ },
  { from: "contracts/solana/deployments", to: "evidence/solana", only: /\.json$/ },
];
