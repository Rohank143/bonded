import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { publicAddress, UnsafeUrlError } from "@bonded/arena";

/**
 * POSTing to a URL an owner chose (their notification webhook) under the Arena's safe-fetch rules
 * (apps/arena/src/safe-fetch.ts): https only, every address the name resolves to must be public
 * (checked when connecting), no redirects, one deadline for the whole call, and the answer capped.
 * Loopback only when the caller says so, for tests.
 */
export interface SafePostOptions {
  timeoutMs: number;
  maxBytes: number;
  allowLoopback?: boolean;
}

export function safePost(
  url: URL,
  body: string,
  headers: Record<string, string>,
  options: SafePostOptions,
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
    lookupOptions: { all?: boolean },
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
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
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
    const deadline = setTimeout(
      () => finish(new Error(`timed out after ${options.timeoutMs} ms`)),
      options.timeoutMs,
    );
    request.on("error", (error) => finish(error));
    request.end(body);
  });
}
