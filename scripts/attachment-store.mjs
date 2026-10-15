/**
 * Attachment materialisation for DevSpec remote control (items 99165e12, b237de43).
 *
 * `poll_connection` returns attachments with base64 `content` AND, for images, a
 * `dataUrl` carrying the same bytes a second time. Writing that verbatim to the
 * poller's stdout or `.inbox.jsonl` puts ~2.7x the source file of base64 into the
 * poll log and the inbox on every delivery — 1.37MB (~341k tokens) for one 500KB
 * screenshot — and a model that reads the inbox line with `jq .messages[].content`
 * never sees the attachment at all (observed live 2026-08-02).
 *
 * The poller therefore materialises attachments BEFORE echoing or persisting a
 * batch: bytes go to `<connectionsDir>/<connectionId>.attachments/`, and the
 * message carries a small descriptor with the absolute `path` and a `note` telling
 * the model to open it. `devspec-remote-wait.mjs` keeps the same pass as an
 * idempotent fallback for inbox lines written by an older poller before upgrade;
 * an already-materialised descriptor has `delivery` set and no `content`/`dataUrl`,
 * so a second pass returns it untouched.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

/**
 * Small text attachments stay inline (UTF-8 decoded) so the model does not burn a
 * Read tool call on a 20-line snippet; anything larger or binary goes to disk.
 */
export const MAX_INLINE_ATTACHMENT_CHARS = 4_000

export function attachmentDirFor(connectionId, baseDir = CONNECTIONS_DIR) {
  return path.join(baseDir, `${connectionId || 'unknown'}.attachments`)
}

function sanitizeAttachmentFilename(name, index) {
  const base = path.basename(String(name || `attachment-${index}`))
  const clean = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '')
  return (clean || `attachment-${index}`).slice(0, 80)
}

function decodeAttachmentBuffer(att) {
  if (typeof att?.content === 'string' && att.content.length > 0) {
    return Buffer.from(att.content, 'base64')
  }
  if (typeof att?.dataUrl === 'string') {
    const comma = att.dataUrl.indexOf(',')
    if (comma !== -1) return Buffer.from(att.dataUrl.slice(comma + 1), 'base64')
  }
  return null
}

export function defaultWriteFile(target, buf) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, buf, { mode: 0o600 })
}

/**
 * Turn one wire attachment into a wake-safe descriptor, writing the decoded bytes to
 * `dir` when needed. Never returns `content` (base64) or `dataUrl`.
 *
 * Idempotent: if `att` is already a descriptor written by an earlier pass (`delivery`
 * present and no raw payload fields), it is returned as-is without touching disk.
 */
export function describeAttachment(
  att,
  { dir, messageId = 'msg', index = 0, writeFile = defaultWriteFile } = {},
) {
  if (!att || typeof att !== 'object') return null

  // Already materialised by the poller at inbox-write time — pass through untouched
  // so `devspec-remote-wait.mjs` stays safe on both new and pre-upgrade inbox lines.
  if (
    typeof att.delivery === 'string' &&
    att.content === undefined &&
    att.dataUrl === undefined
  ) {
    return att
  }

  const filename = att.filename || `attachment-${index}`
  const mimeType = att.mime_type || att.mimeType || 'application/octet-stream'
  const type = att.type || (mimeType.startsWith('image/') ? 'image' : 'binary')
  // Canonical ingress 1.0 materializes attachments as stable metadata references
  // (`materialization: "metadata"`, `resource_id`, `size_bytes`) with no inline base64.
  if (att.materialization === 'metadata' && typeof att.resource_id === 'string') {
    return att
  }

  const buf = decodeAttachmentBuffer(att)
  const sizeBytes = buf ? buf.length : (att.size_bytes ?? att.sizeBytes ?? 0)
  const meta = { filename, mimeType, type, sizeBytes }

  // Nothing to decode (metadata-only stub) — drop rather than emit an empty descriptor.
  if (!buf || buf.length === 0) return null

  if (type === 'text' && buf.length <= MAX_INLINE_ATTACHMENT_CHARS) {
    return { ...meta, delivery: 'inline', content: buf.toString('utf8') }
  }

  if (!dir) {
    return {
      ...meta,
      delivery: 'unavailable',
      note: 'Attachment payload omitted from wake stream (no attachment directory configured).',
    }
  }

  const safeMsg = String(messageId).replace(/[^a-zA-Z0-9_-]+/g, '').slice(0, 36) || 'msg'
  const target = path.join(dir, `${safeMsg}-${index}-${sanitizeAttachmentFilename(filename, index)}`)
  try {
    writeFile(target, buf)
  } catch (e) {
    return {
      ...meta,
      delivery: 'unavailable',
      note: `Failed to save attachment to disk (${e.message}); payload omitted to avoid flooding the turn with base64.`,
    }
  }

  return {
    ...meta,
    delivery: 'file',
    path: target,
    note:
      type === 'image'
        ? 'Image saved to disk — OPEN THIS PATH with your file/image viewer tool (e.g. view_file / Read) to see what the sender attached.'
        : 'Saved to disk — read this path to inspect the attachment.',
  }
}

/** Return a copy of `message` with any raw attachment payloads replaced by descriptors. */
export function materialiseAttachments(message, { dir, writeFile } = {}) {
  if (!message || typeof message !== 'object' || !Array.isArray(message.attachments)) {
    return message
  }
  if (message.attachments.length === 0) return message
  const out = message.attachments
    .map((att, index) => describeAttachment(att, { dir, messageId: message.id || message.message_id, index, writeFile }))
    .filter(Boolean)
  const copy = { ...message }
  if (out.length > 0) copy.attachments = out
  else delete copy.attachments
  return copy
}

/** Materialise every message in an array; returns the input reference when empty. */
export function materialiseBatchAttachments(messages, { dir, writeFile } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return messages
  return messages.map((m) => materialiseAttachments(m, { dir, writeFile }))
}
