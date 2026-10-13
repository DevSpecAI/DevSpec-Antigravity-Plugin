/**
 * Tiered instruction caching per DevSpec connection.
 *
 * When a connection registers (`register_connection`), the server may return
 * `instructions` as a tiered object (`{ tier_0, tier_1, tier_2 }` or string).
 * We cache this in `~/.devspec/instruction-tiers-<connectionId>.json` so hooks
 * like `session-start.mjs` or `pre-prompt-inbox.mjs` can inject the startup /
 * orientation tiers once and consume them without repeating the payload.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveHome() {
  return process.env.HOME || process.env.USERPROFILE || homedir() || '';
}

export function tiersPathFor(connectionId, home = resolveHome()) {
  const safeId = String(connectionId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(home, '.devspec', `instruction-tiers-${safeId}.json`);
}

export function normalizeInstructionsPayload(instructions) {
  if (!instructions) return null;
  if (typeof instructions === 'string') {
    const trimmed = instructions.trim();
    if (!trimmed) return null;
    return { tier_0: trimmed, tier_1: '', tier_2: '' };
  }
  if (typeof instructions === 'object') {
    const tier_0 = typeof instructions.tier_0 === 'string' ? instructions.tier_0.trim() : '';
    const tier_1 = typeof instructions.tier_1 === 'string' ? instructions.tier_1.trim() : '';
    const tier_2 = typeof instructions.tier_2 === 'string' ? instructions.tier_2.trim() : '';
    if (!tier_0 && !tier_1 && !tier_2) return null;
    return { tier_0, tier_1, tier_2 };
  }
  return null;
}

export function storeTiers(connectionId, instructions, { home = resolveHome() } = {}) {
  if (!connectionId || !home) return false;
  const normalized = normalizeInstructionsPayload(instructions);
  if (!normalized) return false;
  const p = tiersPathFor(connectionId, home);
  try {
    mkdirSync(join(home, '.devspec'), { recursive: true, mode: 0o700 });
    writeFileSync(
      p,
      JSON.stringify(
        {
          connection_id: connectionId,
          stored_at: new Date().toISOString(),
          tiers: normalized,
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    return true;
  } catch {
    return false;
  }
}

export function readTiersFor(connectionId, { home = resolveHome() } = {}) {
  if (!connectionId || !home) return null;
  const p = tiersPathFor(connectionId, home);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.tiers) return null;
    return raw.tiers;
  } catch {
    return null;
  }
}

export function takeTiersFor(connectionId, { home = resolveHome(), consume = true } = {}) {
  const tiers = readTiersFor(connectionId, { home });
  if (!tiers) return null;
  if (consume) {
    try {
      rmSync(tiersPathFor(connectionId, home), { force: true });
    } catch {
      /* ignore */
    }
  }
  return tiers;
}

export function formatTiersForStartup(tiers) {
  if (!tiers || typeof tiers !== 'object') return '';
  return [tiers.tier_0, tiers.tier_1].filter(Boolean).join('\n\n').trim();
}
