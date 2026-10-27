/**
 * Whether a module is the script node was started with, so it runs its command-line
 * entry only then and stays quiet when another script imports it.
 *
 * Real paths are compared, never strings or URLs. `import.meta.url` percent-encodes
 * a space ("Antigravity%20extension") while `process.argv[1]` does not, so the
 * `import.meta.url === \`file://${process.argv[1]}\`` idiom is silently false under
 * any folder with a space in its name, and the script does nothing at all. A
 * relative `argv[1]` or a symlinked plugin folder defeats a plain path comparison in
 * the same way. Every script in this plugin uses this one check (item 9e385793), and
 * `entry-point.test.mjs` fails on any that does not.
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export function isEntryPoint(moduleUrl, argv1 = process.argv[1]) {
  if (typeof argv1 !== 'string' || !argv1) return false
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}
