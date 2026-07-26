import { promises as fs } from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";

/**
 * The user's Anthropic API key, persisted between launches.
 *
 * Encrypted at rest with Electron's safeStorage, which defers to the OS
 * credential store (Keychain, DPAPI, or a Linux keyring) instead of this app
 * rolling its own crypto. Everything here is main-process only — the key must
 * never cross IPC to the renderer, so there is deliberately no IPC-safe
 * accessor for it. secretStatus() exists so the renderer can ask whether a
 * key is configured without ever seeing it.
 */

/** Whether a key can be stored at all, and whether one already is. */
export interface SecretStatus {
  /** safeStorage can actually encrypt on this machine. */
  available: boolean;
  hasKey: boolean;
  /** Why storage is unavailable, written for a human. Absent when available. */
  reason?: string;
}

function keyPath(): string {
  // Not a module-level constant: app.getPath is unsafe to call before the
  // app is ready, same reasoning as settingsPath() in settings.ts.
  return path.join(app.getPath("userData"), "claude-key.bin");
}

export async function secretStatus(): Promise<SecretStatus> {
  const available = safeStorage.isEncryptionAvailable();

  let hasKey: boolean;
  try {
    await fs.access(keyPath());
    hasKey = true;
  } catch {
    hasKey = false;
  }

  if (!available) {
    return {
      available,
      hasKey,
      reason:
        "No OS credential store is available on this system (Keychain, DPAPI, or a Linux keyring), so a key cannot be encrypted for storage.",
    };
  }

  return { available, hasKey };
}

/** Rejects when safeStorage is unavailable, rather than writing plaintext. */
export async function setApiKey(key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key cannot be empty.");

  // No plaintext fallback: a key that can't be encrypted is a key that
  // doesn't get stored. Silently writing it in the open here is exactly the
  // failure mode this module exists to prevent.
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "Cannot save the API key: no OS credential store is available on this machine to encrypt it with.",
    );
  }

  const target = keyPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, safeStorage.encryptString(trimmed));
}

/** Null when absent or undecryptable. Main process only — never send this over IPC. */
export async function getApiKey(): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) return null;

  let encrypted: Buffer;
  try {
    encrypted = await fs.readFile(keyPath());
  } catch {
    return null;
  }

  try {
    return safeStorage.decryptString(encrypted);
  } catch {
    // The OS keychain changed, the user migrated machines, or the file is
    // corrupt — all legitimate. An undecryptable key is not an error state
    // for the caller, it's the same as having no key at all.
    return null;
  }
}

export async function clearApiKey(): Promise<void> {
  try {
    await fs.unlink(keyPath());
  } catch (err) {
    // Already gone is success, not failure.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
