import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

/**
 * Fetching from a URL someone else chose (an agent's TEE endpoint, or its Agent URL) without letting them aim the
 * Arena at its own network (SSRF): https only, every address the name resolves to must be public
 * (checked at connect time, so a name can't switch to a private address after the check), no
 * redirects, a time limit and a size limit. The time limit is a deadline on the whole fetch (name
 * lookup, connect, TLS, headers and the full body), not an idle timeout, so an endpoint that sends
 * a byte every few seconds can't hold the caller past it. Loopback is allowed only when the caller
 * says so explicitly, for a local simulator.
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

/** The fetch ran past its deadline. */
export class FetchTimeoutError extends Error {}

export interface SafeFetchOptions {
  /** Deadline for the whole fetch, from the name lookup to the last byte of the body. */
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
  return safeRequest(url, { ...options, method: "GET", headers: { accept: "application/json" } });
}

export interface SafeRequestOptions extends SafeFetchOptions {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Sends one request to `url` under the rules above (a GET, or a POST with a body). Resolves with
 * the status and body text of any answer that isn't a redirect.
 */
export function safeRequest(
  url: URL,
  options: SafeRequestOptions,
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
    let settled = false;
    let response: IncomingMessage | undefined;
    const finish = (error: Error | undefined, result?: { status: number; text: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) {
        response?.destroy();
        request.destroy();
        reject(error);
      } else resolve(result!);
    };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: options.method,
        headers: {
          ...options.headers,
          ...(options.body === undefined
            ? {}
            : { "content-length": String(Buffer.byteLength(options.body)) }),
        },
        lookup: lookup as never,
      },
      (res: IncomingMessage) => {
        response = res;
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          finish(new UnsafeUrlError("redirects are not followed"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            finish(new UnsafeUrlError(`the answer is over ${options.maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          finish(undefined, { status, text: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", (error) => finish(error));
        res.on("close", () => finish(new Error("the connection closed before the answer ended")));
      },
    );
    // One timer for the whole fetch. It starts in the same tick as the request, before the name
    // lookup, and traffic never resets it.
    const deadline = setTimeout(
      () => finish(new FetchTimeoutError(`timed out after ${options.timeoutMs} ms`)),
      options.timeoutMs,
    );
    request.on("error", (error) => finish(error));
    request.end(options.body);
  });
}
