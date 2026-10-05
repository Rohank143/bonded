# Wallet integration research

Checked 2026-10-05 against first-party documentation and source. Scope: Bonded's React web app, its existing wagmi/viem contract hooks, and Robinhood Chain testnet (46630).

## Recommendation

Use RainbowKit's provider and stock `ConnectButton` for the complete wallet selection, account/disconnect, error and network-switching interface. Keep wagmi for contract reads, writes and signatures. RainbowKit documents both the [provider setup](https://rainbowkit.com/docs/installation) and [button behavior](https://rainbowkit.com/docs/connect-button), and accepts the existing custom Robinhood chain through wagmi `createConfig` ([custom chains](https://rainbowkit.com/docs/custom-chains)).

RainbowKit's published documentation identifies version **2.2.11**; its [package manifest](https://github.com/rainbow-me/rainbowkit/blob/main/packages/rainbowkit/package.json) requires **wagmi ^2.9.0**, **viem 2.x**, **React/React DOM >=18** and **TanStack Query >=5**. Bonded's React 19 and viem 2 fit. Replace wagmi 3.7.7 with a verified wagmi 2 release rather than suppressing peer incompatibility. Existing `useAccount`, `useWriteContract`, `useSignMessage`, read hooks and transaction hooks should be checked with the installed v2 types/build.

## Wallets and project IDs

The official `phantomWallet`, `rabbyWallet` and `injectedWallet` implementations are browser-injected connectors, with no WalletConnect relay or project ID dependency: [Phantom source](https://github.com/rainbow-me/rainbowkit/blob/main/packages/rainbowkit/src/wallets/walletConnectors/phantomWallet/phantomWallet.ts), [Rabby source](https://github.com/rainbow-me/rainbowkit/blob/main/packages/rainbowkit/src/wallets/walletConnectors/rabbyWallet/rabbyWallet.ts), [generic injected source](https://github.com/rainbow-me/rainbowkit/blob/main/packages/rainbowkit/src/wallets/walletConnectors/injectedWallet/injectedWallet.ts). Phantom uses `window.phantom.ethereum`; Rabby uses its provider flag. EIP-6963 discovery supplies installed wallets through wagmi; RainbowKit describes its installed-wallet list in the [migration guide](https://rainbowkit.com/docs/migration-guide).

`connectorsForWallets` still types `projectId` as a required string. Its [implementation](https://github.com/rainbow-me/rainbowkit/blob/main/packages/rainbowkit/src/wallets/connectorsForWallets.ts) only forwards that value to the chosen wallet factories. **Inference from source:** an empty string is safe when the entire list consists of those injected-only wallet factories, because they ignore the argument; this must be exercised with the installed package. Do not insert a fabricated credential or include WalletConnect-dependent wallets without a real project ID. RainbowKit's [installation docs](https://rainbowkit.com/docs/installation) require a real project ID for apps that rely on WalletConnect. Mobile QR connection needs that additional configuration; browser extensions and supported in-wallet browsers use injection.

## Why not Phantom Connect SDK here

The [Phantom React SDK](https://docs.phantom.com/sdks/react-sdk) includes a complete modal and stock button, but its documented setup uses a Portal App ID and domain allowlisting. The same page says new Portal applications are paused, embedded EVM support is planned for later in 2026, and its SDK supported-EVM-chain table omits Robinhood. These are SDK integration limitations/uncertainties, not evidence that the Phantom wallet cannot transact on Robinhood.

Phantom's wallet support docs explicitly list [Robinhood Chain as supported](https://help.phantom.com/articles/41372840389651) and [Robinhood Chain Testnet in testnet mode](https://help.phantom.com/articles/use-testnets-in-phantom-5997313271699). The existing browser extension can therefore remain an option in RainbowKit. For a manual Phantom test, enable Settings → Developer Settings → Testnet Mode and choose Robinhood Chain Testnet.

## Integration verification

Replace the application-owned connection mutation/loading button and timeout connector with the stock package UI and connectors. Retain the explicit chain requirement for transactions. Verify: no extension installed (installation choices), installed wallet selection, rejecting connection (recoverable library error and retry), dismissing the modal, reconnect after refresh, switching to chain 46630, rejecting network change, disconnect/account changes, and rejection of a signature or transaction. An extension that never settles its provider request cannot be guaranteed to resolve by any UI library; test the actual extension rejection in addition to a simulated rejecting EIP-1193 provider.
