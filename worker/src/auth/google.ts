// Google OAuth 2.0 / OpenID Connect (authorization code + PKCE) via oauth4webapi.
// Static endpoint metadata: no discovery fetch per login.
import * as oauth from "oauth4webapi";
import { z } from "zod";
import type { Fetcher } from "../app-env";

export const GOOGLE_AS: oauth.AuthorizationServer = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
};

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
/** Exactly these scopes. Never the full `drive` scope. */
export const SCOPES = ["openid", "email", "profile", DRIVE_FILE_SCOPE] as const;

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch: Fetcher;
}

/** The refresh token is no longer valid (revoked, expired, or Testing-mode 7-day expiry). */
export class GoogleInvalidGrantError extends Error {
  readonly code = "invalid_grant";
}

/** Any other OAuth failure (bad callback, token endpoint error, invalid ID token). `code` is safe to log. */
export class GoogleAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const IdClaims = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.literal(true),
  name: z.string().optional(),
});
export type IdClaims = z.infer<typeof IdClaims>;

export interface CodeExchangeResult {
  claims: IdClaims;
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
  grantedScopes: string[];
}

const client = (cfg: GoogleConfig): oauth.Client => ({ client_id: cfg.clientId });
const fetchOpt = (cfg: GoogleConfig) => ({ [oauth.customFetch]: cfg.fetch as typeof fetch });

export function newAuthRequest(): { state: string; codeVerifier: string } {
  return { state: oauth.generateRandomState(), codeVerifier: oauth.generateRandomCodeVerifier() };
}

export async function authorizationUrl(
  cfg: GoogleConfig,
  req: { state: string; codeVerifier: string; consent: boolean },
): Promise<URL> {
  const url = new URL(GOOGLE_AS.authorization_endpoint!);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", req.state);
  url.searchParams.set("code_challenge", await oauth.calculatePKCECodeChallenge(req.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  // Only forced on first login / when no refresh token is stored (spec, flow 1).
  if (req.consent) url.searchParams.set("prompt", "consent");
  return url;
}

/** Validates the callback (state, error), exchanges the code and validates the ID token (iss, aud, exp, iat). */
export async function exchangeCode(
  cfg: GoogleConfig,
  callbackUrl: URL,
  expected: { state: string; codeVerifier: string },
): Promise<CodeExchangeResult> {
  let params: URLSearchParams;
  try {
    params = oauth.validateAuthResponse(GOOGLE_AS, client(cfg), callbackUrl, expected.state);
  } catch (e) {
    if (e instanceof oauth.AuthorizationResponseError) throw new GoogleAuthError(e.error === "access_denied" ? "access_denied" : "authorization_error");
    throw new GoogleAuthError("bad_callback");
  }

  let result: oauth.TokenEndpointResponse;
  try {
    const res = await oauth.authorizationCodeGrantRequest(
      GOOGLE_AS,
      client(cfg),
      oauth.ClientSecretPost(cfg.clientSecret),
      params,
      cfg.redirectUri,
      expected.codeVerifier,
      fetchOpt(cfg),
    );
    result = await oauth.processAuthorizationCodeResponse(GOOGLE_AS, client(cfg), res, {
      requireIdToken: true,
      expectedNonce: oauth.expectNoNonce,
    });
  } catch (e) {
    if (e instanceof oauth.ResponseBodyError) throw new GoogleAuthError(`token_${e.error}`);
    throw new GoogleAuthError("token_exchange_failed");
  }

  // The ID token comes straight from Google's token endpoint over TLS, so OIDC Core 3.1.3.7 allows
  // skipping its signature check. oauth4webapi has already checked iss, aud, exp and iat.
  const parsed = IdClaims.safeParse(oauth.getValidatedIdTokenClaims(result));
  if (!parsed.success) throw new GoogleAuthError("id_token_claims");

  return {
    claims: parsed.data,
    accessToken: result.access_token,
    expiresIn: result.expires_in ?? 3600,
    refreshToken: result.refresh_token,
    grantedScopes: (result.scope ?? "").split(" ").filter(Boolean),
  };
}

export async function refreshAccessToken(cfg: GoogleConfig, refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  try {
    const res = await oauth.refreshTokenGrantRequest(GOOGLE_AS, client(cfg), oauth.ClientSecretPost(cfg.clientSecret), refreshToken, fetchOpt(cfg));
    const result = await oauth.processRefreshTokenResponse(GOOGLE_AS, client(cfg), res);
    return { accessToken: result.access_token, expiresIn: result.expires_in ?? 3600 };
  } catch (e) {
    if (e instanceof oauth.ResponseBodyError && e.error === "invalid_grant") throw new GoogleInvalidGrantError("invalid_grant");
    if (e instanceof oauth.ResponseBodyError) throw new GoogleAuthError(`refresh_${e.error}`);
    throw new GoogleAuthError("refresh_failed");
  }
}
