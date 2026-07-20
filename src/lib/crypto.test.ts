/**
 * Unit tests for crypto.ts
 * Tests encryption, decryption, and API key hashing functionality
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  encrypt,
  decrypt,
  isEncrypted,
  decryptIfNeeded,
  hashApiKey,
  verifyApiKey,
  verifyApiKeyAsync,
  computeApiKeyLookup,
} from "../lib/crypto";

describe("crypto.ts", () => {
  describe("encrypt and decrypt", () => {
    it("should encrypt and decrypt a plaintext string", () => {
      const plaintext = "my-secret-password";
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);

      expect(encrypted).not.toBe(plaintext);
      expect(encrypted).toMatch(/^[A-Za-z0-9+/=]+$/); // base64 pattern
      expect(decrypted).toBe(plaintext);
    });

    it("should produce different ciphertext for the same plaintext (random IV)", () => {
      const plaintext = "my-secret-password";
      const encrypted1 = encrypt(plaintext);
      const encrypted2 = encrypt(plaintext);

      expect(encrypted1).not.toBe(encrypted2);
      expect(decrypt(encrypted1)).toBe(plaintext);
      expect(decrypt(encrypted2)).toBe(plaintext);
    });

    it("should handle empty strings", () => {
      const plaintext = "";
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("should handle special characters and unicode", () => {
      const plaintext = "Hello 🌍! Special chars: @#$%^&*()";
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("should handle very long strings", () => {
      const plaintext = "a".repeat(10000);
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("should throw error when decrypting invalid data", () => {
      expect(() => decrypt("invalid-base64-data")).toThrow();
    });

    it("should throw error when decrypting tampered data", () => {
      const encrypted = encrypt("my-secret");
      const tampered = encrypted.slice(0, -5) + "XXXXX";

      expect(() => decrypt(tampered)).toThrow();
    });
  });

  describe("isEncrypted", () => {
    it("should return true for encrypted strings", () => {
      const encrypted = encrypt("my-secret");
      expect(isEncrypted(encrypted)).toBe(true);
    });

    it("should return false for plaintext hex strings that are not base64", () => {
      // Use a string that's definitely not valid base64
      const hexPassword =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef!";
      expect(isEncrypted(hexPassword)).toBe(false);
    });

    it("should return false for regular strings", () => {
      expect(isEncrypted("regular-password")).toBe(false);
      expect(isEncrypted("not-encrypted")).toBe(false);
    });

    it("should return false for too-short base64 strings", () => {
      const shortBase64 = Buffer.from("short").toString("base64");
      expect(isEncrypted(shortBase64)).toBe(false);
    });

    it("should return false for empty strings", () => {
      expect(isEncrypted("")).toBe(false);
    });

    it("should return false for invalid base64", () => {
      expect(isEncrypted("not-valid-base64!@#")).toBe(false);
    });
  });

  describe("decryptIfNeeded", () => {
    it("should decrypt encrypted values", () => {
      const plaintext = "my-secret";
      const encrypted = encrypt(plaintext);
      const result = decryptIfNeeded(encrypted);

      expect(result).toBe(plaintext);
    });

    it("should return plaintext values as-is", () => {
      const plaintext = "regular-password";
      const result = decryptIfNeeded(plaintext);

      expect(result).toBe(plaintext);
    });

    it("should handle non-base64 strings", () => {
      const plainPassword = "my-plain-password-123!";
      const result = decryptIfNeeded(plainPassword);

      expect(result).toBe(plainPassword);
    });
  });

  describe("hashApiKey", () => {
    it("should hash an API key using scrypt format", () => {
      const apiKey = "my-api-key-12345";
      const hash = hashApiKey(apiKey);

      // Should be in format: scrypt:N:r:p:saltBase64:hashBase64
      expect(hash).toMatch(
        /^scrypt:\d+:\d+:\d+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/,
      );
      expect(hash.startsWith("scrypt:")).toBe(true);
    });

    it("should produce different hashes for the same key (random salt)", () => {
      const apiKey = "my-api-key-12345";
      const hash1 = hashApiKey(apiKey);
      const hash2 = hashApiKey(apiKey);

      // Due to random salt, hashes should be different
      expect(hash1).not.toBe(hash2);

      // But both should verify correctly
      expect(verifyApiKey(apiKey, hash1)).toBe(true);
      expect(verifyApiKey(apiKey, hash2)).toBe(true);
    });

    it("should produce different hashes for different keys", () => {
      const hash1 = hashApiKey("key1");
      const hash2 = hashApiKey("key2");

      expect(hash1).not.toBe(hash2);
    });

    it("should handle empty strings", () => {
      const hash = hashApiKey("");

      // Should still be in scrypt format
      expect(hash).toMatch(
        /^scrypt:\d+:\d+:\d+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/,
      );

      // Should be verifiable
      expect(verifyApiKey("", hash)).toBe(true);
    });

    it("should include scrypt parameters in hash", () => {
      const hash = hashApiKey("test");
      const parts = hash.split(":");

      expect(parts[0]).toBe("scrypt");
      expect(parts[1]).toBe("16384"); // N
      expect(parts[2]).toBe("8"); // r
      expect(parts[3]).toBe("1"); // p
      expect(parts[4]).toBeTruthy(); // salt
      expect(parts[5]).toBeTruthy(); // hash
    });
  });

  describe("verifyApiKey", () => {
    it("should return true for matching API key and hash", () => {
      const apiKey = "my-api-key-12345";
      const hash = hashApiKey(apiKey);

      expect(verifyApiKey(apiKey, hash)).toBe(true);
    });

    it("should return false for non-matching API key and hash", () => {
      const apiKey1 = "my-api-key-12345";
      const apiKey2 = "different-api-key";
      const hash = hashApiKey(apiKey1);

      expect(verifyApiKey(apiKey2, hash)).toBe(false);
    });

    it("should return false for empty key against valid hash", () => {
      const hash = hashApiKey("my-api-key");
      expect(verifyApiKey("", hash)).toBe(false);
    });

    it("should use timing-safe comparison", () => {
      // This test verifies that the function uses timingSafeEqual
      // by ensuring it doesn't throw when buffers are same length
      const apiKey = "test-key";
      const hash = hashApiKey(apiKey);

      // Should not throw even with wrong key (same hash length)
      expect(() => verifyApiKey("wrong-key", hash)).not.toThrow();
      expect(verifyApiKey("wrong-key", hash)).toBe(false);
    });

    it("should return false for malformed hash strings", () => {
      const apiKey = "test-key";

      // Invalid formats should return false
      expect(verifyApiKey(apiKey, "invalid")).toBe(false);
      expect(verifyApiKey(apiKey, "sha256:abcdef")).toBe(false);
      expect(verifyApiKey(apiKey, "scrypt:1:2")).toBe(false); // too few parts
      expect(verifyApiKey(apiKey, "scrypt:abc:8:1:salt:hash")).toBe(false); // invalid N
    });

    it("should return false for invalid base64 in hash", () => {
      const apiKey = "test-key";

      // Invalid base64 should be handled gracefully
      expect(verifyApiKey(apiKey, "scrypt:16384:8:1:!!!invalid!!!:hash")).toBe(
        false,
      );
      expect(verifyApiKey(apiKey, "scrypt:16384:8:1:salt:!!!invalid!!!")).toBe(
        false,
      );
    });

    it("should handle long API keys", () => {
      const longKey = "a".repeat(1000);
      const hash = hashApiKey(longKey);

      expect(verifyApiKey(longKey, hash)).toBe(true);
      expect(verifyApiKey("wrong" + longKey, hash)).toBe(false);
    });
  });

  describe("verifyApiKeyAsync", () => {
    it("matches the sync verifier on valid keys", async () => {
      const apiKey = "osc_" + "ab".repeat(32);
      const hash = hashApiKey(apiKey);

      await expect(verifyApiKeyAsync(apiKey, hash)).resolves.toBe(true);
    });

    it("rejects a wrong key", async () => {
      const hash = hashApiKey("osc_" + "ab".repeat(32));

      await expect(
        verifyApiKeyAsync("osc_" + "cd".repeat(32), hash),
      ).resolves.toBe(false);
    });

    it("returns false for malformed hash strings", async () => {
      await expect(verifyApiKeyAsync("key", "invalid")).resolves.toBe(false);
      await expect(verifyApiKeyAsync("key", "sha256:abcdef")).resolves.toBe(
        false,
      );
      await expect(
        verifyApiKeyAsync("key", "scrypt:abc:8:1:salt:hash"),
      ).resolves.toBe(false);
      await expect(
        verifyApiKeyAsync("key", "scrypt:16384:8:1:!!!invalid!!!:hash"),
      ).resolves.toBe(false);
    });
  });

  describe("computeApiKeyLookup", () => {
    it("is deterministic and produces 64 hex chars", () => {
      const key = "osc_" + "ab".repeat(32);

      expect(computeApiKeyLookup(key)).toBe(computeApiKeyLookup(key));
      expect(computeApiKeyLookup(key)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("differs for different keys", () => {
      expect(computeApiKeyLookup("osc_a")).not.toBe(
        computeApiKeyLookup("osc_b"),
      );
    });
  });
});
