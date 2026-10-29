// Who is calling. On Foliation the edge signs every request with X-Foliation-User
// (docs/agents/migrate.md, "App login to Foliation sharing"); a runner arrives as a service token
// (docs/foliation-app-service-tokens.md: `svc: true`). Without FOLIATION_ISSUER we are in local
// dev: browsers are a fake owner and runners present TETHER_DEV_RUNNER_TOKEN.

import { createLocalJWKSet, createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface Viewer {
  id: string;
  email: string;
  name: string;
  role: string;
  service: boolean;
}

const env = process.env;
export const DEV = !env.FOLIATION_ISSUER;
const DEV_RUNNER_TOKEN = env.TETHER_DEV_RUNNER_TOKEN ?? "dev";

const local = createLocalJWKSet(JSON.parse(env.FOLIATION_JWKS ?? '{"keys":[]}'));
const remote = env.FOLIATION_BROKER_URL
  ? createRemoteJWKSet(new URL("/v1/jwks", env.FOLIATION_BROKER_URL), { cacheMaxAge: 5 * 60_000 })
  : null;
const keys: JWTVerifyGetKey = async (header, token) => {
  if (remote) {
    try {
      return await remote(header, token);
    } catch (e) {
      if (e instanceof errors.JWKSNoMatchingKey) throw e;
    }
  }
  return local(header, token);
};

export async function viewerFrom(req: Request): Promise<Viewer | null> {
  if (DEV) {
    const auth = req.headers.get("authorization");
    if (auth) return auth === `Bearer ${DEV_RUNNER_TOKEN}` ? { id: "svc:dev", email: "", name: "runner", role: "editor", service: true } : null;
    return { id: "dev", email: "dev@localhost", name: "Developer", role: "owner", service: false };
  }
  const token = req.headers.get("x-foliation-user");
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: env.FOLIATION_ISSUER,
      audience: env.FOLIATION_AUDIENCE,
      algorithms: ["EdDSA"],
      clockTolerance: 5,
    });
    return {
      id: String(payload.sub),
      email: String(payload.email ?? ""),
      name: String(payload.name ?? ""),
      role: String(payload.role ?? ""),
      service: payload.svc === true,
    };
  } catch {
    return null;
  }
}

/** Browsers: only the app's owners (it runs shell commands on your machines). */
export const isOwner = (v: Viewer | null) => !!v && !v.service && v.role === "owner";

/** Runners: a service token named runner or runner-* with the editor role. */
export const isRunner = (v: Viewer | null) => !!v && v.service && v.role === "editor" && /^runner(-|$)/.test(v.name);
