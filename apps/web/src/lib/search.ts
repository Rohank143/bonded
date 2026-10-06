/** Where a search box query should go: an agent by ID, a vault by address, or a tx on the explorer. */
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
  if (/^0x[0-9a-fA-F]{64}$/.test(q) && deps.explorerUrl)
    return { href: `${deps.explorerUrl}/tx/${q}`, external: true };
  return null;
}
