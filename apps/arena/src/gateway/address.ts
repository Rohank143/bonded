import { isIP } from "node:net";

/** An address for rate limits: IPv4 as is, IPv6 by its /64 (IPv4-mapped IPv6 as IPv4). */
export function addressGroup(ip: string): string {
  const bare = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (mapped) return mapped[1]!;
  if (isIP(bare) !== 6) return bare;
  // Expand :: to full groups, then keep the first four.
  const [head, tail = ""] = bare.split("::");
  const left = head ? head.split(":") : [];
  const right = bare.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = bare.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}
