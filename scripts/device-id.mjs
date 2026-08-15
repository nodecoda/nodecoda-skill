// scripts/device-id.mjs
// Guest device identity persistence (free-campaign PRD K-E3).
//
// The try instance anchors guest builds on X-NodeCoda-Device-Id (S-B2). The
// skill generates one UUID v4 per machine, persists it to
// ~/.nodecoda/device.json (0600), and reuses it across sessions so a guest
// keeps the same device identity (and quota window) until they register.
// The server only ever stores sha256(device_id), never the plaintext.
//
// Pure Node built-ins, no dependencies. NODECODA_DEVICE_ID env override exists
// for tests/CI; a read-only filesystem falls back to an in-memory id so the
// MCP server still boots.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// NODECODA_DEVICE_DIR overrides the persistence directory (tests, containers).
function devicePaths(env = process.env) {
  const dir = env.NODECODA_DEVICE_DIR || join(homedir(), '.nodecoda');
  return { dir, file: join(dir, 'device.json') };
}

/** Loads or creates the persistent device id (idempotent, cross-session). */
export function loadDeviceId(env = process.env) {
  if (env.NODECODA_DEVICE_ID && env.NODECODA_DEVICE_ID.length >= 8) {
    return env.NODECODA_DEVICE_ID;
  }
  const { dir, file } = devicePaths(env);
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof raw.device_id === 'string' && raw.device_id.length >= 8) {
        return raw.device_id;
      }
    }
    const id = `nodecoda-${randomUUID()}`;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({
      device_id: id,
      created_at: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
    return id;
  } catch {
    // Read-only filesystem / privacy mode: in-memory id, still functional
    // for the current session (same behaviour as www LivePlayground).
    return `nodecoda-${randomUUID()}`;
  }
}
