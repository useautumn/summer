import * as http from "node:http";
import * as arctic from "arctic";
import open from "open";
import {
  DEFAULT_AUTUMN_API_URL,
  DEFAULT_AUTUMN_APP_URL
} from "../config/constants.ts";
import { AutumnClient } from "../clients/autumn.ts";
import { readAuth, writeAuth } from "../config/storage.ts";
import { bold, cyan, dim } from "../cli/style.ts";
import type { SummerAuth } from "../domain/types.ts";

const OAUTH_PORTS = [31548, 31549, 31550, 31551, 31552];
const DEFAULT_CLIENT_ID = "autumn_summer";
const REFRESH_WINDOW_MS = 5 * 60_000;

const apiUrl = () => process.env.SUMMER_AUTUMN_API_URL ?? DEFAULT_AUTUMN_API_URL;
const appUrl = () => process.env.SUMMER_AUTUMN_APP_URL ?? DEFAULT_AUTUMN_APP_URL;
const clientId = () => {
  const value = process.env.SUMMER_OAUTH_CLIENT_ID?.trim();
  return value && value.length > 0 ? value : DEFAULT_CLIENT_ID;
};

function authorizationEndpoint() {
  return `${apiUrl()}/api/auth/oauth2/authorize`;
}

function tokenEndpoint() {
  return `${apiUrl()}/api/auth/oauth2/token`;
}

export function getOAuthDebugConfig() {
  return {
    apiUrl: apiUrl(),
    appUrl: appUrl(),
    clientId: clientId(),
    authorizationEndpoint: authorizationEndpoint()
  };
}

function prefixOAuthToken(token: string) {
  return token.startsWith("am_oauth_") ? token : `am_oauth_${token}`;
}

function authFromTokens(tokens: arctic.OAuth2Tokens, previous: Partial<SummerAuth> = {}): SummerAuth {
  return {
    accessToken: prefixOAuthToken(tokens.accessToken()),
    tokenType: "Bearer",
    expiresAt: tokens.accessTokenExpiresInSeconds()
      ? Date.now() + tokens.accessTokenExpiresInSeconds() * 1000
      : previous.expiresAt,
    refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : previous.refreshToken,
    apiUrl: apiUrl(),
    appUrl: appUrl(),
    org: previous.org,
    user: previous.user
  };
}

function htmlEscape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function startCallbackServer(
  port: number,
  onCallback: (url: URL) => Promise<SummerAuth>
): Promise<{ result: Promise<SummerAuth> } | null> {
  const server = http.createServer();
  const result = new Promise<SummerAuth>((resolve, reject) => {
    server.on("request", async (req, res) => {
      try {
        const url = new URL(req.url || "/", `http://localhost:${port}`);
        const auth = await onCallback(url);
        const redirectTo = auth.appUrl || appUrl();
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="refresh" content="0;url=${htmlEscape(redirectTo)}">
    <title>Summer is authenticated</title>
  </head>
  <body>
    <p>Summer is authenticated. Redirecting to <a href="${htmlEscape(redirectTo)}">Autumn</a>.</p>
    <script>window.location.replace(${JSON.stringify(redirectTo)});</script>
  </body>
</html>`);
        server.close();
        resolve(auth);
      } catch (error) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(error instanceof Error ? error.message : String(error));
        server.close();
        reject(error);
      }
    });
  });

  const listening = await new Promise<boolean>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    server.listen(port, () => resolve(true));
  });

  if (!listening) return null;
  return { result };
}

export async function login(): Promise<SummerAuth> {
  const codeVerifier = arctic.generateCodeVerifier();
  const state = arctic.generateState();

  for (const port of OAUTH_PORTS) {
    const redirectUri = `http://localhost:${port}/`;
    const client = new arctic.OAuth2Client(clientId(), null, redirectUri);
    const authUrl = client.createAuthorizationURLWithPKCE(
      authorizationEndpoint(),
      state,
      arctic.CodeChallengeMethod.S256,
      codeVerifier,
      [
        "organisation:read",
        "customers:read",
        "customers:write",
        "balances:read",
        "balances:write",
        "features:read",
        "features:write",
        "analytics:read",
        "offline_access"
      ]
    );
    authUrl.searchParams.set("client_id", clientId());
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("env", "sandbox");

    const server = await startCallbackServer(port, async (url) => {
      if (url.searchParams.get("state") !== state) {
        throw new Error("Invalid OAuth state");
      }
      const code = url.searchParams.get("code");
      if (!code) throw new Error("Missing OAuth code");

      const tokens = await client.validateAuthorizationCode(
        tokenEndpoint(),
        code,
        codeVerifier
      );
      // Return the HYDRATED auth (with org + user), not the bare token auth, so callers
      // (e.g. the login command's confirmation print) see the resolved org/user.
      return hydrateAndStoreAuth(authFromTokens(tokens));
    });
    if (server === null) continue;

    console.log();
    console.log(bold("Logging in to Autumn"));
    console.log(dim("Opening your browser to authorize Summer…"));
    console.log(dim("If it doesn't open, paste this URL:"));
    console.log(`  ${cyan(authUrl.toString())}`);
    console.log();
    console.log(dim("Waiting for you to finish in the browser…"));
    await open(authUrl.toString());
    return await server.result;
  }

  throw new Error("All Summer OAuth callback ports are in use.");
}

export async function hydrateAndStoreAuth(auth: SummerAuth) {
  const client = new AutumnClient(auth);
  const org = await client.organizationMe();
  const user = org.user;
  if (!user?.id) {
    throw new Error(
      "Autumn /v1/organization/me did not return user.id. Summer needs the Autumn user id as customerId."
    );
  }
  const next = {
    ...auth,
    org: { id: org.id, name: org.name, slug: org.slug, env: org.env },
    user
  };
  await writeAuth(next);
  return next;
}

export async function refreshAuth(auth: SummerAuth) {
  if (!auth.refreshToken) return auth;
  const client = new arctic.OAuth2Client(clientId(), null, "http://localhost/");
  const tokens = await client.refreshAccessToken(tokenEndpoint(), auth.refreshToken, []);
  return hydrateAndStoreAuth(authFromTokens(tokens, auth));
}

export async function requireAuth() {
  const auth = await readAuth();
  if (!auth) return login();
  if (auth.expiresAt && auth.expiresAt <= Date.now() + REFRESH_WINDOW_MS) {
    try {
      return await refreshAuth(auth);
    } catch {
      return login();
    }
  }
  if (!auth.user?.id) return hydrateAndStoreAuth(auth);
  return auth;
}
