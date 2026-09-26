/**
 * Chain facts for every network Bonded deploys to. See docs/PLAN.md Section 15.
 *
 * Every fact records where it came from. "docs" means read from official docs or
 * explorers on the date in `checkedOn`; "unverified" means it still needs an on-chain
 * check before deployment (Day 4). Fill in `null` values as they are confirmed.
 */

export type FactSource = "docs" | "unverified";

export interface Fact<T> {
  value: T;
  source: FactSource;
  note?: string;
}

export interface EvmChainConfig {
  family: "evm";
  key: EvmChainKey;
  name: string;
  chainId: number;
  testnet: boolean;
  rpcUrl: string;
  explorerUrl: string;
  faucets: string[];
  /** Stablecoin used as the vault and pool base asset. */
  stablecoin: Fact<{ symbol: string; address: `0x${string}` | null; decimals: number }>;
  /** Canonical ERC-8004 registries, where deployed. */
  erc8004: Fact<{ identity: `0x${string}`; reputation: `0x${string}` } | null>;
  notes: string[];
  checkedOn: string;
}

export interface SolanaChainConfig {
  family: "solana";
  key: "solanaDevnet";
  name: string;
  cluster: "devnet";
  testnet: true;
  rpcUrl: string;
  explorerUrl: string;
  faucets: string[];
  stablecoin: Fact<{ symbol: string; mint: string; decimals: number }>;
  notes: string[];
  checkedOn: string;
}

export type EvmChainKey = "robinhoodTestnet" | "robinhoodMainnet" | "arbitrumSepolia" | "sepolia";

export const EVM_CHAINS: Record<EvmChainKey, EvmChainConfig> = {
  robinhoodTestnet: {
    family: "evm",
    key: "robinhoodTestnet",
    name: "Robinhood Chain Testnet",
    chainId: 46630,
    testnet: true,
    rpcUrl: "https://rpc.testnet.chain.robinhood.com/rpc",
    explorerUrl: "https://explorer.testnet.chain.robinhood.com",
    faucets: [
      "https://faucet.testnet.chain.robinhood.com",
      "https://faucets.chain.link/robinhood-testnet",
      "https://faucet.quicknode.com/robinhood/testnet",
    ],
    stablecoin: {
      value: { symbol: "USDG", address: null, decimals: 6 },
      source: "unverified",
      note:
        "Paxos USDG was live on testnet at launch; address and decimals to confirm on-chain. " +
        "Fall back to a Bonded mock USDC if unavailable.",
    },
    erc8004: {
      value: null,
      source: "unverified",
      note: "No canonical deployment found; deploy the reference implementation.",
    },
    notes: [
      "Arbitrum Orbit L2 that settles to Ethereum Sepolia; gas is testnet ETH.",
      "Faucet also drips test Stock Tokens (TSLA, AMZN, PLTR, NFLX, AMD). Stock Tokens are ERC-20s with 18 decimals.",
      "Uniswap, Morpho and Chainlink were live at testnet launch; addresses to collect from docs.robinhood.com/chain/contracts.",
    ],
    checkedOn: "2026-09-27",
  },
  robinhoodMainnet: {
    family: "evm",
    key: "robinhoodMainnet",
    name: "Robinhood Chain",
    chainId: 4663,
    testnet: false,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    explorerUrl: "https://robinhoodchain.blockscout.com",
    faucets: [],
    stablecoin: { value: { symbol: "USDC", address: null, decimals: 6 }, source: "unverified" },
    erc8004: { value: null, source: "unverified" },
    notes: [
      "Optional capped mainnet deployment on Day 14 (docs/PLAN.md Section 15).",
      "Chainlink feeds exist for Stock Tokens (total return value) and crypto assets.",
    ],
    checkedOn: "2026-09-27",
  },
  arbitrumSepolia: {
    family: "evm",
    key: "arbitrumSepolia",
    name: "Arbitrum Sepolia",
    chainId: 421614,
    testnet: true,
    rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    explorerUrl: "https://sepolia.arbiscan.io",
    faucets: ["https://faucet.circle.com", "https://faucets.chain.link/arbitrum-sepolia"],
    stablecoin: {
      value: { symbol: "USDC", address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", decimals: 6 },
      source: "unverified",
      note: "Circle testnet USDC; confirm on-chain.",
    },
    erc8004: { value: null, source: "unverified" },
    notes: [],
    checkedOn: "2026-09-27",
  },
  sepolia: {
    family: "evm",
    key: "sepolia",
    name: "Ethereum Sepolia",
    chainId: 11155111,
    testnet: true,
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    explorerUrl: "https://sepolia.etherscan.io",
    faucets: ["https://faucet.circle.com", "https://faucets.chain.link/sepolia"],
    stablecoin: {
      value: { symbol: "USDC", address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6 },
      source: "unverified",
      note: "Circle testnet USDC; confirm on-chain.",
    },
    erc8004: {
      value: {
        identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
        reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      },
      source: "docs",
      note: "Canonical reference deployment by the ERC-8004 team.",
    },
    notes: [
      "Hosts the ERC-8004 registries and BondedRegistry; Robinhood Chain testnet settles here.",
    ],
    checkedOn: "2026-09-27",
  },
};

export const SOLANA_DEVNET: SolanaChainConfig = {
  family: "solana",
  key: "solanaDevnet",
  name: "Solana Devnet",
  cluster: "devnet",
  testnet: true,
  rpcUrl: "https://api.devnet.solana.com",
  explorerUrl: "https://explorer.solana.com/?cluster=devnet",
  faucets: ["https://faucet.solana.com", "https://faucet.circle.com"],
  stablecoin: {
    value: { symbol: "USDC", mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6 },
    source: "unverified",
    note: "Circle devnet USDC mint; confirm on-chain.",
  },
  notes: ["Jupiter devnet support to confirm; fall back to a mock AMM."],
  checkedOn: "2026-09-27",
};

export function evmChainById(chainId: number): EvmChainConfig | undefined {
  return Object.values(EVM_CHAINS).find((chain) => chain.chainId === chainId);
}
