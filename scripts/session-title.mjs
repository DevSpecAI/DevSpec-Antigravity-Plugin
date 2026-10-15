/**
 * The attached room's title, kept in the connection's state for the Antigravity
 * status bar (`scripts/statusline.mjs`).
 *
 * The poll response names the room only by id, so the poller reads the title
 * itself: once when the attachment changes, then again only while the room is
 * still untitled. Titles are generated after the first real message, so a room
 * attached while new gets its name a little later; the Pi and Claude Code footers
 * follow the same cadence. A titled room is not re-read, so a rename shows from
 * the next attachment.
 *
 * The read is `get_session_transcript` with an empty window (messages after now,
 * at most one), which answers the room's header and no history.
 */

import { isRealSessionTitle } from './statusline.mjs'

/**
 * How long an untitled room waits before its title is read again. One small read
 * per untitled attached room per minute, and none at all once it has a name.
 */
export const UNTITLED_RETRY_MS = 60_000

/** A title read that hangs must not hold anything up; it is simply tried again. */
const TITLE_READ_TIMEOUT_MS = 10_000

/**
 * Whether the title should be read now for `sessionId`.
 *
 * `state` is the connection's state file (what was last stored), `lastAttemptAt`
 * when this poller last asked for this room's title (0 for never).
 */
export function sessionTitleReadDue({ sessionId, state, lastAttemptAt = 0, now = Date.now() }) {
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (state?.session_title_for !== sessionId) {
    return lastAttemptAt === 0 || now - lastAttemptAt >= UNTITLED_RETRY_MS
  }
  if (isRealSessionTitle(state.session_title)) return false
  return now - lastAttemptAt >= UNTITLED_RETRY_MS
}

/**
 * The room's title as DevSpec has it now, `''` when it has none yet, or null when
 * the read failed (nothing is stored then, and the next due read tries again).
 */
export async function readSessionTitle({ call, mcpUrl, token, sessionId, now = Date.now() }) {
  if (typeof sessionId !== 'string' || !sessionId || typeof call !== 'function') return null
  try {
    const res = await call({
      mcpUrl,
      token,
      name: 'get_session_transcript',
      arguments: { session_id: sessionId, since_created_at: new Date(now).toISOString(), limit: 1 },
      timeoutMs: TITLE_READ_TIMEOUT_MS,
    })
    if (!res || typeof res !== 'object' || res.id !== sessionId) return null
    return typeof res.title === 'string' ? res.title : ''
  } catch {
    return null
  }
}
