import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Serverless filesystems are read-only apart from the temp dir, so fall back to
// it when deployed. Locally we keep the cache in the project for easy inspection.
const DIR = process.env.VERCEL
  ? path.join(os.tmpdir(), "ffcc-cache")
  : path.join(process.cwd(), "data", "cache");

/**
 * Disk cache with a TTL. Three leagues x (rosters + free agents + expert ranks)
 * is a lot of chatter against undocumented endpoints, and expert rankings only
 * move a few times a day — so we cache aggressively and fail open.
 */
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const file = path.join(DIR, `${key.replace(/[^a-z0-9_-]/gi, "_")}.json`);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < ttlMs) {
      return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    }
  } catch {
    // cache miss is the normal path, not an error
  }

  const value = await fn();
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  } catch {
    // an unwritable cache must never break a live request
  }
  return value;
}

/** Last-known-good read, used when a live provider fails mid-request. */
export function stale<T>(key: string): T | null {
  try {
    const file = path.join(DIR, `${key.replace(/[^a-z0-9_-]/gi, "_")}.json`);
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
