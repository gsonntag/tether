// What a push subscription may point at: a push service on the internet over https. A runner
// fetches it, so an endpoint on the runner's own machine or private network is refused (outside a
// dev runner, whose tests use a push service on this machine).

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Loopback, private, link-local, CGNAT, unspecified and multicast addresses (v4, v6, v4-mapped). */
export function privateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return privateAddress(mapped[1]!);
    return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s);
  }
  return true;
}

/** Why a push endpoint is refused, or undefined when it's fine. `dev`: plain http to this machine allowed. */
export async function endpointProblem(endpoint: string, dev: boolean, resolve: (host: string) => Promise<string[]> = defaultResolve): Promise<string | undefined> {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return "That isn't a push endpoint.";
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const local = host === "localhost" || (isIP(host) && privateAddress(host));
  if (dev && u.protocol === "http:" && (host === "localhost" || host === "127.0.0.1")) return undefined;
  if (u.protocol !== "https:") return "A push endpoint must be https.";
  if (local) return dev ? undefined : "A push endpoint can't be on this machine or its network.";
  if (isIP(host)) return undefined;
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch {
    return "The push service's name doesn't resolve.";
  }
  if (!dev && addrs.some(privateAddress)) return "A push endpoint can't be on this machine or its network.";
  return undefined;
}

const defaultResolve = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address);
