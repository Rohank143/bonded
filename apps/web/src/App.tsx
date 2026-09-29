import { NavLink, Outlet } from "react-router";
import { ConnectButton } from "./components/wallet";

const links = [
  ["/arena", "Arena"],
  ["/vaults", "Vaults"],
  ["/underwrite", "Underwrite"],
  ["/claims", "Claims"],
] as const;

export function Layout() {
  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-4 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-4">
        <nav className="flex flex-wrap items-center gap-4 text-sm">
          <NavLink to="/" className="text-lg font-bold">
            Bonded
          </NavLink>
          {links.map(([to, label]) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                isActive ? "font-semibold" : "text-muted hover:text-ink"
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <ConnectButton />
      </header>
      <main className="flex-1 py-6">
        <Outlet />
      </main>
      <footer className="border-t border-line py-4 text-xs text-muted">
        Robinhood Chain testnet. Test tokens only; nothing here has real value.
      </footer>
    </div>
  );
}
