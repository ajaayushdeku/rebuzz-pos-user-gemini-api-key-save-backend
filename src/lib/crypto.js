import crypto from "node:crypto";
import fs from "node:fs";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const CURRENT_KEY_VERSION = 1;

const getKeys = () => {
  // AI_ENCRYPTION_KEY_FILE wins when set: a file path lets orchestrators
  // (Docker secrets, K8s secret volumes) inject the key without it ever
  // appearing in `env` output or a process table. Falls back to the plain
  // variable for local dev.
  const filePath = process.env.AI_ENCRYPTION_KEY_FILE;
  let raw;
  if (filePath) {
    try {
      raw = fs.readFileSync(filePath, "utf8").trim();
    } catch {
      throw new Error(
        `AI_ENCRYPTION_KEY_FILE points at ${filePath} but it could not be read`,
      );
    }
  } else {
    raw = process.env.AI_ENCRYPTION_KEY;
  }
  if (!raw) {
    throw new Error(
      filePath
        ? `AI_ENCRYPTION_KEY_FILE points at ${filePath} but it is empty`
        : "AI_ENCRYPTION_KEY is not set",
    );
  }

  const key = Buffer.from(raw, "hex");
  if (key.length != 32) {
    throw new Error("AI_ENCRYPTION_KEY must be 32 bytes (64 hex characters)");
  }

  return key;
};

/** Call once at boot so a misconfigured key fails now, not on first write. */
export const assertEncryptionReady = () => {
  getKeys();
};

export const encrypt = (plaintext) => {
  // A fresh IV every time. Reusing one under the same key breaks GCM badly:
  // it leaks the XOR of the plaintexts and lets the auth tag be forged.
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKeys(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    // Without the tag stored, decryption cannot detect tampering — which is
    // the whole reason to pick GCM over CBC.
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion: CURRENT_KEY_VERSION,
  };
};

export const decrypt = (record) => {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getKeys(),
    Buffer.from(record.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(record.authTag, "base64"));

  // final() throws when the tag does not verify. Let it: a failed auth check
  // means the record was altered, and returning anything would be worse.
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
};

/** "AIza••••4f2c" — for display, never a usable credential. */
export const maskKey = (plaintext) => {
  const value = plaintext.trim();
  if (value.length <= 10) return "••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
};
