/**
 * Whether a browser origin may call the API. Each allowed entry is an exact origin, or an https
 * origin with one `*` standing for part of a single host label: letters, digits and hyphens,
 * never a dot. So "https://bonded-*-team.vercel.app" lets in every Vercel preview of the web app
 * (bonded-git-<branch>-team.vercel.app) but not "https://x.bonded-a-team.vercel.app".
 */
export function originAllowed(origin: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => {
    if (!entry.includes("*")) return entry === origin;
    if (!entry.startsWith("https://") || entry.split("*").length !== 2) return false;
    const [before, after] = entry.split("*") as [string, string];
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escape(before)}[a-z0-9-]+${escape(after)}$`).test(origin);
  });
}
