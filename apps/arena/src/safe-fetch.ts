import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

/**
 * Fetching from a URL someone else chose (an agent's TEE endpoint) without letting them aim the
 * Arena at its own network (SSRF): https only, every address the name resolves to must be public
 * (checked at connect time, so a name can't switch to a private address after the check), no
 * redirects, a time limit and a size limit. Loopback is allowed only when the caller says so
 * explicitly, for a local simulator.
 */

const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  NOT_PUBLIC.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  NOT_PUBLIC.addSubnet(network, prefix, "ipv6");
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/** Whether the Arena may connect to this address. */
export function publicAddress(address: string, allowLoopback = false): boolean {
  let ip = address.replace(/^\[|\]$/g, "");
  // An IPv4 address written as IPv6 (::ffff:10.0.0.1) is judged as the IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  const family = isIP(ip);
  if (family === 0) return false;
  const type = family === 4 ? "ipv4" : "ipv6";
  if (LOOPBACK.check(ip, type)) return allowLoopback;
  if (family === 6 && /^::ffff:/i.test(ip)) return false;
  return !NOT_PUBLIC.check(ip, type);
}

export class UnsafeUrlError extends Error {}

export interface SafeFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  /** Allow loopback addresses and plain http to them (a local simulator only). */
  allowLoopback?: boolean;
}

/** GETs `url` under the rules above. Resolves with the status and body text. */
export function safeGet(
  url: URL,
  options: SafeFetchOptions,
): Promise<{ status: number; text: string }> {
  const loopbackHost =
    url.hostname === "localhost" ||
    publicAddress(url.hostname, true) !== publicAddress(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(options.allowLoopback && url.protocol === "http:" && loopbackHost)
  )
    return Promise.reject(new UnsafeUrlError("the URL must use https"));
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal) && !publicAddress(literal, options.allowLoopback))
    return Promise.reject(new UnsafeUrlError("the URL points at a private or internal address"));

  const lookup = (
    hostname: string,
    lookupOptions: { all?: boolean; family?: number },
    callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    dnsLookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
      if (error) return callback(error, "");
      const list = addresses as LookupAddress[];
      if (list.length === 0 || list.some((a) => !publicAddress(a.address, options.allowLoopback)))
        return callback(
          new UnsafeUrlError("the name resolves to a private or internal address"),
          "",
        );
      if (lookupOptions.all) callback(null, list);
      else callback(null, list[0]!.address, list[0]!.family);
    });
  };

  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      { method: "GET", headers: { accept: "application/json" }, lookup: lookup as never },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.destroy();
          reject(new UnsafeUrlError("redirects are not followed"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            response.destroy();
            reject(new UnsafeUrlError(`the answer is over ${options.maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ status, text: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", reject);
      },
    );
    request.setTimeout(options.timeoutMs, () => request.destroy(new Error("timed out")));
    request.on("error", reject);
    request.end();
  });
}
