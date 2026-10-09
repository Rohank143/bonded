import { type ActionProvider, AgentKit, type WalletProvider } from "@coinbase/agentkit";
import { type BondedEpisode, isBondedEpisode } from "@bonded/sdk";
import { bondedEpisodeActionProvider } from "@bonded/sdk/agentkit";

/**
 * Coinbase AgentKit with the episode's tools while it is being rated, and its own action
 * providers otherwise. Hand `kit.getActions()` to your framework extension as usual
 * (`getLangChainTools(kit)`, `getVercelAITools(kit)`).
 */
export async function agentKitFor(options: {
  walletProvider: WalletProvider;
  /** The agent's production action providers. */
  actionProviders: ActionProvider[];
  /** Set in Agent URL mode; under the runner the episode comes from `BONDED_*`. */
  episode?: BondedEpisode;
}): Promise<AgentKit> {
  const rated = options.episode !== undefined || isBondedEpisode();
  return AgentKit.from({
    walletProvider: options.walletProvider,
    actionProviders: rated
      ? [await bondedEpisodeActionProvider(options.episode)]
      : options.actionProviders,
  });
}
