import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider, darkTheme, lightTheme } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { wagmiConfig } from "./wagmi";
import { robinhoodTestnet } from "./config";
import { Layout } from "./App";
import { OperatorTokenProvider } from "./components/wallet";
import { Landing } from "./pages/Landing";
import { Arena } from "./pages/Arena";
import { Agent } from "./pages/Agent";
import { Agents } from "./pages/Agents";
import { Vaults } from "./pages/Vaults";
import { Vault } from "./pages/Vault";
import { Underwrite } from "./pages/Underwrite";
import { Claims } from "./pages/Claims";
import { Leaderboard } from "./pages/Leaderboard";
import { Bounties } from "./pages/Bounties";
import { NotFound } from "./pages/NotFound";
import { NewAgent } from "./pages/NewAgent";
import "./index.css";

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Landing /> },
      { path: "/arena", element: <Arena /> },
      { path: "/agents", element: <Agents /> },
      { path: "/agents/new", element: <NewAgent /> },
      { path: "/agents/:id", element: <Agent /> },
      { path: "/vaults", element: <Vaults /> },
      { path: "/vaults/:address", element: <Vault /> },
      { path: "/underwrite", element: <Underwrite /> },
      { path: "/claims", element: <Claims /> },
      { path: "/leaderboard", element: <Leaderboard /> },
      { path: "/bounties", element: <Bounties /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });
const walletTheme = {
  lightMode: lightTheme({
    accentColor: "#0f1419",
    accentColorForeground: "#f7f6f2",
    borderRadius: "small",
    fontStack: "system",
  }),
  darkMode: darkTheme({
    accentColor: "#eceae4",
    accentColorForeground: "#111315",
    borderRadius: "small",
    fontStack: "system",
  }),
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider initialChain={robinhoodTestnet} theme={walletTheme} modalSize="compact">
          <OperatorTokenProvider>
            <RouterProvider router={router} />
          </OperatorTokenProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
