/**
 * Whether a sidebar link matches the current address. Links to one page with and without
 * `?mine=1` ("Agents" and "Your agents", "Cover pool" and "Your underwriting") are different
 * entries, so only the one whose `mine` matches is active.
 */
export function isNavActive(to: string, pathname: string, search: string, end = false): boolean {
  const [path, query = ""] = to.split("?");
  const mine = (q: string) => new URLSearchParams(q).get("mine") === "1";
  const onPath = end ? pathname === path : pathname === path || pathname.startsWith(`${path}/`);
  return onPath && mine(query) === mine(search);
}
