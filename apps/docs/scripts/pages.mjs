/**
 * Which repository documents become pages, and where. The repo's Markdown stays the single
 * source: the site is generated from it, so the two cannot drift.
 *
 * `src` is relative to the repository root; `slug` is the page's path under /docs/.
 */
export const PAGES = [
  { src: "README.md", slug: "overview/introduction", label: "Introduction", title: "Introduction" },
  {
    src: "docs/PLAN.md",
    slug: "overview/plan",
    label: "Product specification",
    title: "Product specification",
  },
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
];

/** Folders whose Markdown files each become a page, in file-name order. None for now. */
export const FOLDERS = [];

/** Where evidence files live on the site. Linked from the notes that cite them. */
export const EVIDENCE_DIRS = [
  { from: "docs/progress/evidence", to: "evidence" },
  { from: "contracts/evm/deployments", to: "evidence/deployments", only: /\.json$/ },
  { from: "contracts/solana/deployments", to: "evidence/solana", only: /\.json$/ },
];

/** How a doc is named in running prose when a bare mention of its file turns into a link. */
export const SHORT_NAMES = {
  "README.md": "the introduction",
  "SECURITY.md": "the security policy",
  "docs/PLAN.md": "the product specification",
  "docs/BUSINESS.md": "the business page",
  "docs/ARCHITECTURE.md": "the architecture page",
  "docs/AGENTS.md": "the agents page",
  "docs/BOUNTIES-EXPLAINED.md": "the bounty overview",
  "docs/BOUNTIES.md": "the bounty guide",
  "docs/DEVELOPING.md": "the developer guide",
  "docs/SERVICES.md": "the hosted services page",
  "docs/TEE.md": "the TEE runbook",
  "docs/SENTINEL.md": "the Sentinel page",
  "docs/SENTINEL-STRESS.md": "the stress suite page",
  "docs/AUDIT.md": "the audit note",
  "docs/disclosures/README.md": "the disclosure policy",
  "contracts/evm/README.md": "the contracts page",
  "contracts/evm/deployments/README.md": "the deployments page",
};

/** Sections left out of the site. */
export const DROP_SECTIONS = {
  // The build schedule, demo script, submission checklist and founder's to-do list are internal.
  "docs/PLAN.md": ["20.", "21.", "22.", "24.", "27."],
};
