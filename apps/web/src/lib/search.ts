/**
 * Where a search box query should go: an agent by ID, a vault by address, an attack by its id
 * (e.g. A4-honeypot-otc-004), or a tx on the explorer.
 */
export type SearchTarget = { href: string; external: boolean };

export function searchTarget(
  query: string,
  deps: { isAddress: (value: string) => boolean; explorerUrl: string },
): SearchTarget | null {
  const q = query
    .trim()
    .replace(/^#/, "")
    .replace(/^agent\s+/i, "");
  if (/^\d+$/.test(q)) return { href: `/agents/${BigInt(q)}`, external: false };
  if (deps.isAddress(q)) return { href: `/vaults/${q}`, external: false };
  if (/^a(10|[1-9])-[a-z0-9-]+$/i.test(q))
    return {
      href: `/attacks/${q.toUpperCase().slice(0, q.indexOf("-"))}${q.slice(q.indexOf("-")).toLowerCase()}`,
      external: false,
    };
  if (/^0x[0-9a-fA-F]{64}$/.test(q) && deps.explorerUrl)
    return { href: `${deps.explorerUrl}/tx/${q}`, external: true };
  return null;
}
