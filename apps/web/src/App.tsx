import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ConnectButton } from "./components/wallet";
import { LinkButton, Logo } from "./components/ui";
import { networkName } from "./config";
import { api } from "./lib/api";

const REPO = "https://github.com/ddboy19912/bonded";

/** The pages people come to read, then the ones where they put money or work in. */
const groups = [
  {
    label: "Explore",
    links: [
      ["/agents", "Agents"],
      ["/leaderboard", "Leaderboard"],
      ["/arena", "Arena"],
      ["/claims", "Claims"],
    ],
  },
  {
    label: "Take part",
    links: [
      ["/vaults", "Vaults"],
      ["/underwrite", "Underwrite"],
      ["/bounties", "Bounties"],
    ],
  },
] as const;

const navLink = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors ${
    isActive ? "bg-sunken text-ink" : "text-muted hover:text-ink"
  }`;

export function Layout() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-line bg-paper/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6">
          <Link to="/" onClick={close} className="shrink-0" aria-label="Bonded home">
            <span className="hidden sm:block">
              <Logo className="h-9" />
            </span>
            <span className="sm:hidden">
              <Logo variant="symbol" className="h-7" />
            </span>
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-1 lg:flex">
            {groups.map((g, i) => (
              <div key={g.label} className="flex items-center gap-1">
                {i > 0 && <span className="mx-2 h-4 w-px bg-line-strong" aria-hidden />}
                {g.links.map(([to, label]) => (
                  <NavLink key={to} to={to} className={navLink}>
                    {label}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden xl:block">
              <LinkButton to="/agents/new" kind="secondary" size="sm">
                Onboard an agent
              </LinkButton>
            </span>
            <ConnectButton />
            <button
              type="button"
              className="inline-flex size-10 items-center justify-center rounded-lg border border-line-strong lg:hidden"
              aria-expanded={open}
              aria-controls="mobile-nav"
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={() => setOpen((o) => !o)}
            >
              <svg viewBox="0 0 20 20" className="size-5" fill="none" aria-hidden>
                {open ? (
                  <path
                    d="M5 5l10 10M15 5L5 15"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                ) : (
                  <path
                    d="M3 6h14M3 10h14M3 14h14"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                )}
              </svg>
            </button>
          </div>
        </div>
        {open && (
          <nav
            id="mobile-nav"
            aria-label="Main"
            className="border-t border-line bg-paper px-4 pt-3 pb-5 sm:px-6 lg:hidden"
          >
            {groups.map((g) => (
              <div key={g.label} className="mb-3">
                <p className="px-2.5 pb-1 text-xs font-semibold tracking-[0.12em] text-muted uppercase">
                  {g.label}
                </p>
                <div className="grid grid-cols-2 gap-1">
                  {g.links.map(([to, label]) => (
                    <NavLink key={to} to={to} className={navLink} onClick={close}>
                      {label}
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
            <div className="px-2.5 pt-1" onClick={close}>
              <LinkButton to="/agents/new">Onboard an agent</LinkButton>
            </div>
          </nav>
        )}
      </header>
      <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}

function Footer() {
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 30_000 });
  const status = health.isError
    ? { dot: "bg-breach", label: "Services unreachable" }
    : health.data?.ok
      ? { dot: "bg-safe", label: "Services online" }
      : { dot: "bg-line-strong", label: "Checking services" };
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8 sm:flex-row sm:items-start sm:justify-between sm:px-6">
        <div className="flex flex-col gap-3">
          <Logo className="h-9" />
          <p className="max-w-sm text-sm text-muted">
            Don't cage your agent. Bond it. Running on {networkName}, with test tokens only: nothing
            here has real value.
          </p>
        </div>
        <div className="flex flex-col gap-3 text-sm sm:items-end">
          <span className="inline-flex items-center gap-2 text-muted">
            <span className={`size-2 rounded-full ${status.dot}`} aria-hidden />
            {status.label}
          </span>
          <div className="flex gap-4">
            <a className="text-muted hover:text-ink" href={REPO} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a
              className="text-muted hover:text-ink"
              href={`${REPO}/tree/main/docs`}
              target="_blank"
              rel="noreferrer"
            >
              Docs
            </a>
            <a
              className="text-muted hover:text-ink"
              href={`${REPO}/blob/main/SECURITY.md`}
              target="_blank"
              rel="noreferrer"
            >
              Security
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
