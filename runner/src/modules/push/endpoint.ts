// What a push subscription may point at: a push service on the internet over https. A runner
// fetches it, so an endpoint on the runner's own machine or private network is refused (outside a
// dev runner, whose tests use a push service on this machine). The address checked is the address
// connected to (sender.ts pins it), so a name that resolves elsewhere a moment later gets nowhere.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function v4Private(b: number[]): boolean {
  const [a, c] = b as [number, number];
  return a === 0 || a === 10 || a === 127 || (a === 100 && c >= 64 && c < 128) || (a === 169 && c === 254) || (a === 172 && c >= 16 && c < 32) || (a === 192 && c === 168) || (a === 192 && c === 0) || (a === 198 && (c === 18 || c === 19)) || a >= 224;
}

/** An IPv6 address as its 16 bytes (embedded dotted IPv4 too), or undefined. */
export function v6Bytes(ip: string): number[] | undefined {
  let s = ip.toLowerCase().split("%")[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  let tail: number[] = [];
  if (dotted) {
    tail = dotted[1]!.split(".").map(Number);
    if (tail.some((x) => x > 255)) return undefined;
    s = s.slice(0, -dotted[1]!.length) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const part = (x: string) => (x ? x.split(":") : []);
  const head = part(halves[0]!);
  const back = halves.length === 2 ? part(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - back.length : 0;
  const groups = [...head, ...Array(Math.max(0, fill)).fill("0"), ...back];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return undefined;
  const bytes = groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
  if (dotted) bytes.splice(12, 4, ...tail);
  return bytes;
}

/**
 * Loopback, private, link-local, site-local, unique-local, CGNAT, documentation, unspecified and
 * multicast addresses, and IPv6 forms that carry an IPv4 address (mapped, compatible, NAT64, 6to4,
 * Teredo), judged by the address they carry. Anything unparsable counts as private.
 */
export function privateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const b = ip.split(".").map(Number);
    return v4Private(b);
  }
  if (v !== 6) return true;
  const b = v6Bytes(ip);
  if (!b) return true;
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible, ::1 and :: included), ::ffff:0:a.b.c.d (SIIT)
  if (zero(0, 10) && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0))) return zero(0, 16) || (zero(0, 15) && b[15] === 1) || v4Private(b.slice(12));
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && zero(10, 12)) return v4Private(b.slice(12));
  // 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64)
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true;
  // 2002::/16 (6to4): its IPv4 in bytes 2..5
  if (b[0] === 0x20 && b[1] === 0x02) return v4Private(b.slice(2, 6));
  // 2001::/32 (Teredo) and 2001:db8::/32 (documentation)
  if (b[0] === 0x20 && b[1] === 0x01 && ((b[2] === 0 && b[3] === 0) || (b[2] === 0x0d && b[3] === 0xb8))) return true;
  // fc00::/7 unique-local, fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast, 100::/64 discard
  if ((b[0]! & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1]! & 0xc0) >= 0x80) || b[0] === 0xff) return true;
  if (b[0] === 1 && zero(1, 8)) return true;
  return false;
}

export type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;
export const defaultResolve: Resolve = (host) => lookup(host, { all: true });

/** Why a push endpoint is refused, or undefined when it's fine. `dev`: plain http to this machine allowed. */
export async function endpointProblem(endpoint: string, dev: boolean, resolve: Resolve = defaultResolve): Promise<string | undefined> {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return "That isn't a push endpoint.";
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (dev && u.protocol === "http:" && (host === "localhost" || host === "127.0.0.1")) return undefined;
  if (u.protocol !== "https:") return "A push endpoint must be https.";
  if (dev) return undefined;
  const local = "A push endpoint can't be on this machine or its network.";
  if (host === "localhost" || host.endsWith(".localhost")) return local;
  if (isIP(host)) return privateAddress(host) ? local : undefined;
  let addrs: { address: string }[];
  try {
    addrs = await resolve(host);
  } catch {
    return "The push service's name doesn't resolve.";
  }
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) return local;
  return undefined;
}

/**
 * A `lookup` for node:http(s) that resolves once, refuses private addresses (outside `dev`), and
 * hands the connection exactly the address it checked: no second resolution to rebind.
 */
export function pinnedLookup(dev: boolean, resolve: Resolve = defaultResolve) {
  return (host: string, opts: any, cb: (err: Error | null, address?: any, family?: number) => void) => {
    const options = typeof opts === "function" ? {} : (opts ?? {});
    const done = typeof opts === "function" ? opts : cb;
    resolve(host).then(
      (addrs) => {
        const ok = dev ? addrs : addrs.filter((a) => !privateAddress(a.address));
        if (!ok.length || ok.length !== addrs.length) return done(Object.assign(new Error("A push endpoint can't be on this machine or its network."), { code: "EPRIVATE" }));
        if (options.all) done(null, ok);
        else done(null, ok[0]!.address, ok[0]!.family);
      },
      (e) => done(e),
    );
  };
}
