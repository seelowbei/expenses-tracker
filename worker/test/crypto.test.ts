import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken, signValue, TokenCryptoError, verifySignedValue } from "../src/auth/crypto";
import { fromBase64, fromBase64Url, toBase64Url } from "../src/lib/encoding";

const OTHER_KEY = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI="; // 32 x 0x02

describe("refresh token encryption", () => {
  it("round-trips in the v1:<iv>:<ciphertext> format with a 12-byte IV", async () => {
    const stored = await encryptToken(env.TOKEN_ENC_KEY, "1//refresh-token");
    const [v, iv, ct] = stored.split(":");
    expect(v).toBe("v1");
    expect(fromBase64(iv!)).toHaveLength(12);
    expect(ct).not.toContain("refresh");
    expect(await decryptToken(env.TOKEN_ENC_KEY, stored)).toBe("1//refresh-token");
  });

  it("uses a fresh IV every time", async () => {
    const a = await encryptToken(env.TOKEN_ENC_KEY, "same");
    const b = await encryptToken(env.TOKEN_ENC_KEY, "same");
    expect(a).not.toBe(b);
  });

  it("rejects a wrong key, tampered ciphertext and malformed values", async () => {
    const stored = await encryptToken(env.TOKEN_ENC_KEY, "secret");
    await expect(decryptToken(OTHER_KEY, stored)).rejects.toBeInstanceOf(TokenCryptoError);

    const [v, iv, ct] = stored.split(":");
    const bytes = fromBase64(ct!);
    bytes[0]! ^= 1;
    const tampered = `${v}:${iv}:${btoa(String.fromCharCode(...bytes))}`;
    await expect(decryptToken(env.TOKEN_ENC_KEY, tampered)).rejects.toBeInstanceOf(TokenCryptoError);

    for (const bad of ["", "v2:a:b", "v1:only-two", "v1:!!!:???", `v1:${btoa("short")}:${ct}`]) {
      await expect(decryptToken(env.TOKEN_ENC_KEY, bad)).rejects.toBeInstanceOf(TokenCryptoError);
    }
  });

  it("refuses keys that are not 32 bytes", async () => {
    await expect(encryptToken(btoa("too short"), "x")).rejects.toThrow(/32 bytes/);
  });
});

describe("signed values", () => {
  it("round-trips and rejects tampering or another secret", async () => {
    const signed = await signValue(env.SESSION_SECRET, '{"state":"abc"}');
    expect(await verifySignedValue(env.SESSION_SECRET, signed)).toBe('{"state":"abc"}');
    expect(await verifySignedValue(OTHER_KEY, signed)).toBeNull();

    const [, sig] = signed.split(".");
    const forged = `${toBase64Url(new TextEncoder().encode('{"state":"evil"}'))}.${sig}`;
    expect(await verifySignedValue(env.SESSION_SECRET, forged)).toBeNull();
    for (const bad of ["", "abc", "a.b.c", "%%%.%%%"]) expect(await verifySignedValue(env.SESSION_SECRET, bad)).toBeNull();
  });

  it("base64url round-trips without padding", () => {
    const bytes = new Uint8Array([251, 255, 0, 1]);
    const s = toBase64Url(bytes);
    expect(s).not.toMatch(/[+/=]/);
    expect(fromBase64Url(s)).toEqual(bytes);
  });
});
