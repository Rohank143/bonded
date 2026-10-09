import {
  AgentKit,
  erc20ActionProvider,
  type EvmWalletProvider,
  walletActionProvider,
} from "@coinbase/agentkit";

/** The AgentKit chatbot template's setup, with the wallet provider built by the caller. */
export async function initializeAgent(walletProvider: EvmWalletProvider) {
  const agentkit = await AgentKit.from({
    walletProvider,
    actionProviders: [erc20ActionProvider(), walletActionProvider()],
  });
  return agentkit.getActions();
}
