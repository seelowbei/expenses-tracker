// Refresh-token encryption (AES-GCM) and HMAC-signed cookie values. Pure Web Crypto.
import { fromBase64, fromBase64Url, randomBytes, toBase64, toBase64Url } from "../lib/encoding";

export class TokenCryptoError extends Error {
  readonly code = "token_decrypt_failed";
}

const aesKeys = new Map<string, Promise<CryptoKey>>();
const hmacKeys = new Map<string, Promise<CryptoKey>>();

function decodeKey(secretB64: string, what: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = fromBase64(secretB64.trim());
  } catch {
    throw new Error(`${what} is not valid base64`);
  }
  if (raw.length !== 32) throw new Error(`${what} must be 32 bytes (openssl rand -base64 32)`);
  return raw;
}

function aesKey(secretB64: string): Promise<CryptoKey> {
  let key = aesKeys.get(secretB64);
  if (!key) {
    const raw = decodeKey(secretB64, "TOKEN_ENC_KEY");
    key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    aesKeys.set(secretB64, key);
  }
  return key;
}

function hmacKey(secretB64: string): Promise<CryptoKey> {
  let key = hmacKeys.get(secretB64);
  if (!key) {
    const raw = decodeKey(secretB64, "SESSION_SECRET");
    key = crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    hmacKeys.set(secretB64, key);
  }
  return key;
}

/** Encrypts a refresh token as `v1:<iv b64>:<ciphertext b64>` with a random 12-byte IV. */
export async function encryptToken(secretB64: string, plaintext: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secretB64), new TextEncoder().encode(plaintext));
  return `v1:${toBase64(iv)}:${toBase64(new Uint8Array(ct))}`;
}

/** Throws TokenCryptoError on a malformed value, wrong key or tampered ciphertext. */
export async function decryptToken(secretB64: string, stored: string): Promise<string> {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "v1") throw new TokenCryptoError("unsupported token format");
  let iv: Uint8Array;
  let ct: Uint8Array;
  try {
    iv = fromBase64(parts[1]!);
    ct = fromBase64(parts[2]!);
  } catch {
    throw new TokenCryptoError("invalid base64");
  }
  if (iv.length !== 12) throw new TokenCryptoError("invalid iv");
  // Outside the try: a malformed TOKEN_ENC_KEY is a config error, not an unreadable token.
  const key = await aesKey(secretB64);
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    throw new TokenCryptoError("decryption failed");
  }
}

/** `<payload b64url>.<hmac b64url>`. The payload is readable by the client; only integrity is protected. */
export async function signValue(secretB64: string, payload: string): Promise<string> {
  const data = new TextEncoder().encode(payload);
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secretB64), data);
  return `${toBase64Url(data)}.${toBase64Url(new Uint8Array(sig))}`;
}

/** Returns the payload, or null if the value is malformed or the signature does not match. */
export async function verifySignedValue(secretB64: string, value: string): Promise<string | null> {
  const [p, s, extra] = value.split(".");
  if (!p || !s || extra !== undefined) return null;
  try {
    const data = fromBase64Url(p);
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secretB64), fromBase64Url(s), data);
    return ok ? new TextDecoder().decode(data) : null;
  } catch {
    return null;
  }
}
