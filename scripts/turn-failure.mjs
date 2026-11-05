/**
 * Tell the room when Antigravity could not finish a command (item 408ad47b).
 *
 * When an error ends an Antigravity turn (sign-in expired, a quota, a provider outage,
 * a dropped connection…), Antigravity still runs the Stop hook, with
 * `terminationReason: "ERROR"` and its own error text in `error`. The model left no
 * reply for the turn, so the Stop fallback that mirrors the model's last words found
 * nothing and the room stayed silent while the error sat in a terminal the person
 * driving from DevSpec cannot see. Verified on Antigravity CLI 1.4.11, 2026-10-31: a
 * turn whose model request was refused mid-session fired Stop with
 * `terminationReason: "ERROR"` and `error: "generating and executing: request failed:
 * Post …: Forbidden"`; a normal turn sends `terminationReason: "NO_TOOL_CALL"` and
 * `error: ""`.
 *
 * Antigravity gives no fixed reason codes in the hook input, only its rendered text,
 * so the text is passed through as written and never matched on or reworded: its
 * messages already say what to do, and Antigravity changes them (the same choice the
 * Claude Code plugin made in item b6a38d81). When there is no text the reply still
 * says the agent couldn't finish, so no failure is ever silent.
 *
 * Imports nothing, so the hook and the tests can load it as they like.
 */

/**
 * The failure as Antigravity reported it, or null when the turn did not end on one.
 * Every field is untrusted text from the hook's stdin.
 */
export function parseTurnFailure(hookInput) {
  if (!hookInput || typeof hookInput !== 'object') return null
  const reason =
    typeof hookInput.terminationReason === 'string'
      ? hookInput.terminationReason
      : typeof hookInput.termination_reason === 'string'
        ? hookInput.termination_reason
        : ''
  const text = typeof hookInput.error === 'string' && hookInput.error.trim() ? hookInput.error.trim() : null
  // Antigravity's proto enum, as the hook serialises it ("ERROR"); the prefixed form
  // is accepted too in case a later version sends the full enum name.
  const endedOnError = /^(TERMINATION_REASON_)?ERROR$/.test(reason)
  if (!endedOnError && !text) return null
  return { text }
}

/**
 * Quote text as a Markdown block, line by line, so the room shows Antigravity's own
 * words apart from ours whatever they contain.
 */
function quote(text) {
  return text.split(/\r?\n/).map((line) => `> ${line}`.trimEnd()).join('\n')
}

/**
 * What the room is told: Antigravity's text whole and as written, or, when it gave
 * none, that it stopped and where to look.
 */
export function turnFailureMessage(failure, agentName) {
  const lead = failure.text
    ? `${agentName} couldn't finish this. It said:\n\n${quote(failure.text)}`
    : `${agentName} couldn't finish this. It stopped with an error; its terminal shows what went wrong.`
  return `${lead}\n\nAnything it asks you to do happens in ${agentName} on the computer it's running on. Once that's sorted, send your message again.`
}
