/**
 * Small, storage-backed identities for browser operations that may be retried
 * after the response is lost.  The server remains the source of truth; this
 * module only keeps the client from accidentally creating a second operation.
 */

export interface ClientStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StableRequestRecord {
  version: 1;
  fingerprint: string;
  requestId: string;
  createdAt: number;
}

export interface PendingProjectCreation extends StableRequestRecord {
  projectId: string;
  idempotencyKey: string;
  projectCreated: boolean;
}

export const PENDING_PROJECT_CREATION_STORAGE_KEY =
  "wolf-research:pending-project-creation";

const RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

function safeStorage(): ClientStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedId(value: unknown, maxLength = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\r\n\0]/u.test(value)
  );
}

function parseBaseRecord(value: unknown, now: number): StableRequestRecord | null {
  if (!isRecord(value)) return null;
  if (value.version !== 1 || !boundedId(value.fingerprint, 128)) return null;
  if (!boundedId(value.requestId, 256)) return null;
  if (
    typeof value.createdAt !== "number" ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt > now ||
    now - value.createdAt > RECORD_MAX_AGE_MS
  ) {
    return null;
  }
  return {
    version: 1,
    fingerprint: value.fingerprint,
    requestId: value.requestId,
    createdAt: value.createdAt,
  };
}

/**
 * Read a request record only when it belongs to the current logical input.
 * A changed input therefore cannot accidentally reuse an old request ID.
 */
export function readStableRequest(
  key: string,
  fingerprint: string,
  storage: ClientStorage | null = safeStorage(),
  now = Date.now(),
): StableRequestRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = parseBaseRecord(JSON.parse(raw) as unknown, now);
    if (!parsed || parsed.fingerprint !== fingerprint) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeStableRequest(
  key: string,
  record: StableRequestRecord,
  storage: ClientStorage | null = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(record));
  } catch {
    // Private browsing and quota policies can make sessionStorage unavailable.
    // The server still enforces request idempotency for the current page.
  }
}

export function clearStableRequest(
  key: string,
  storage: ClientStorage | null = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Best effort only.
  }
}

export function readPendingProjectCreation(
  fingerprint: string,
  storage: ClientStorage | null = safeStorage(),
  now = Date.now(),
): PendingProjectCreation | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PENDING_PROJECT_CREATION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    const base = parseBaseRecord(parsed, now);
    if (!base || base.fingerprint !== fingerprint || !isRecord(parsed)) return null;
    if (!boundedId(parsed.projectId, 100) || !boundedId(parsed.idempotencyKey, 512)) {
      return null;
    }
    if (typeof parsed.projectCreated !== "boolean") return null;
    return {
      ...base,
      projectId: parsed.projectId,
      idempotencyKey: parsed.idempotencyKey,
      projectCreated: parsed.projectCreated,
    };
  } catch {
    return null;
  }
}

export function writePendingProjectCreation(
  record: PendingProjectCreation,
  storage: ClientStorage | null = safeStorage(),
): void {
  writeStableRequest(PENDING_PROJECT_CREATION_STORAGE_KEY, record, storage);
}

export function clearPendingProjectCreation(
  storage: ClientStorage | null = safeStorage(),
): void {
  clearStableRequest(PENDING_PROJECT_CREATION_STORAGE_KEY, storage);
}

function hashString(value: string): string {
  // Two independent 32-bit FNV-style accumulators keep the fingerprint out of
  // storage without introducing a Node-only crypto dependency in the client.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  return `v1-${(first >>> 0).toString(16).padStart(8, "0")}-${
    (second >>> 0).toString(16).padStart(8, "0")
  }-${value.length.toString(16)}`;
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
}

/** Build a non-sensitive, deterministic fingerprint for a logical request. */
export function stableFingerprint(value: unknown): string {
  return hashString(JSON.stringify(canonicalize(value)));
}

export function createClientId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // Fall through to the bounded local fallback.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export function createProjectId(): string {
  return `project-${Date.now()}-${createClientId().replaceAll("-", "").slice(0, 24)}`;
}
