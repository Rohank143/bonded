/**
 * Rules for URLs Bonded calls out to that an owner chose: Agent URLs and notification webhooks.
 */

/** Hosts an Agent URL or webhook may not use: Bonded's own (its web app, API and gateway). */
export function ownDomainsFrom(urls: readonly (string | undefined)[]): string[] {
  const hosts = new Set<string>();
  for (const value of urls) {
    if (!value) continue;
    try {
      const host = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`).hostname;
      // A wildcard origin (bonded-*-team.vercel.app) blocks its parent domain's pattern only.
      hosts.add(host.toLowerCase().replace(/^\*\./, ""));
    } catch {
      /* not a URL: nothing to block */
    }
  }
  // Loopback is ruled by allowLoopback alone (a local web app on localhost mustn't stop a local
  // agent on another port from being used in a local demo).
  return [...hosts].filter((h) => h && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(h));
}

/**
 * Why `raw` can't be an Agent URL (or webhook), or undefined. Public HTTPS only, no credentials
 * or fragment, not one of Bonded's own hosts. Addresses are checked again when connecting
 * (safe-fetch), so a name that resolves to a private address is refused then.
 */
export function outboundUrlProblem(
  raw: string,
  ownDomains: readonly string[],
  allowLoopback = false,
): string | undefined {
  if (raw.length > 2048) return "Your URL is longer than 2,048 characters.";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That isn't a URL.";
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (url.protocol !== "https:" && !(allowLoopback && loopback && url.protocol === "http:"))
    return "Your URL must use https.";
  if (url.username || url.password) return "Your URL can't carry a user name or password.";
  if (url.hash) return "Your URL can't have a #fragment.";
  if (!allowLoopback && (loopback || host.endsWith(".localhost") || host.endsWith(".internal")))
    return "Your URL must be reachable on the public internet.";
  for (const own of ownDomains) {
    const bare = own.replace(/^.*\*/, "");
    if (host === own || host.endsWith(`.${own}`) || (bare !== own && host.endsWith(bare)))
      return "Your URL can't be one of Bonded's own addresses.";
  }
  return undefined;
}
