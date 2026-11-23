/**
 * Everything the plugin says about signing in, in one place, so a hook, the status
 * bar, the connect script and the login command never word the same situation two
 * ways. Plain words for someone who has never seen DevSpec's internals.
 *
 * Also the one reading of the environment token: `DEVSPEC_MCP_TOKEN` (with
 * `DEVSPEC_MCP_URL`) is only for machines with no browser, such as CI or a cloud
 * worker. When it is set it wins over a browser sign-in, so anything interactive
 * says so and says how to remove it.
 */

import path from 'node:path'
import { agentsSettingsUrl, PLUGIN_ROOT, serverLabel } from './devspec-server.mjs'

export const TOKEN_ENV_VAR = 'DEVSPEC_MCP_TOKEN'
export const URL_ENV_VAR = 'DEVSPEC_MCP_URL'

/** The environment token, when one is really set (not empty, not a placeholder). */
export function envToken(env = process.env) {
  const raw = env?.[TOKEN_ENV_VAR]
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value || /^dvs_your(?:_|$)/i.test(value) || value.includes('YOUR_') || /^<.*>$/.test(value) || /^\$\{.*\}$/.test(value)) {
    return null
  }
  return value
}

export function envTokenSet(env = process.env) {
  return envToken(env) !== null
}

export function envTokenNotice(platform = process.platform) {
  const where =
    platform === 'win32'
      ? 'System Properties → Environment Variables, and any terminal profile that sets it'
      : `your shell profile (for example ~/.zshrc or ~/.bashrc) and this terminal (\`unset ${TOKEN_ENV_VAR}\`)`
  return (
    `${TOKEN_ENV_VAR} is set in this environment, so remote control and commit tracking use that token instead of a browser sign-in. ` +
    `To use your browser sign-in, remove ${TOKEN_ENV_VAR} from ${where}, then restart agy.`
  )
}

export function loginCommand(pluginRoot = PLUGIN_ROOT) {
  return `node "${path.join(pluginRoot, 'scripts', 'devspec-login.mjs')}"`
}

/** No browser sign-in for this server yet. */
export function notSignedInMessage(mcpUrl) {
  return `Remote control and commit tracking are not signed in to DevSpec ${serverLabel(mcpUrl)} yet. Run /devspec-login to sign in through your browser (one approval, as Antigravity).`
}

/** The saved sign-in stopped working: refused renewal, or Antigravity was disconnected in DevSpec. */
export function signInEndedMessage(mcpUrl) {
  return (
    `Antigravity's DevSpec sign-in for remote control and commit tracking has ended, for example because Antigravity was disconnected in Agent setup (${agentsSettingsUrl(mcpUrl)}). ` +
    'Run /devspec-login to sign in again.'
  )
}

export function signInStartedMessage(url) {
  return url
    ? `To turn on remote control and commit tracking, approve Antigravity on DevSpec's page in the browser tab that just opened (a one-time step). If no tab opened, open this link:\n\n${url}`
    : "To turn on remote control and commit tracking, approve Antigravity on DevSpec's page in the browser tab that just opened (a one-time step). If no tab opened, run /devspec-login."
}

export function signInWaitingMessage(url) {
  return url
    ? `Waiting for you to approve Antigravity on DevSpec's page in your browser. If you closed the tab, open this link:\n\n${url}`
    : "Waiting for you to approve Antigravity on DevSpec's page in your browser. If you closed the tab, run /devspec-login."
}

export function needsCodeMessage(pluginRoot = PLUGIN_ROOT) {
  return (
    'Remote control and commit tracking need one sign-in, and your browser cannot reach this machine. ' +
    `Run /devspec-login --code (or \`${loginCommand(pluginRoot)} --code\` in a terminal here) and paste back the code DevSpec's page shows.`
  )
}

/**
 * DevSpec refused a credential. `signed_out` is DevSpec's own sentence (Antigravity
 * was disconnected) followed by how to sign in again; the environment token is named
 * as the thing to replace when it was the one refused.
 */
export function refusedCredentialMessage({ serverCode = null, serverMessage = null, source = 'login' } = {}) {
  if (source === 'env') {
    return `DevSpec did not accept the token in ${TOKEN_ENV_VAR}${serverMessage ? ` (${serverMessage})` : ''}. Replace it with a working token from Agent setup, or remove it to use your browser sign-in.`
  }
  if (serverCode === 'signed_out') {
    const said =
      typeof serverMessage === 'string' && serverMessage.trim()
        ? serverMessage.trim()
        : 'Antigravity was disconnected from your DevSpec account. You can reconnect it from Agent setup in your DevSpec settings.'
    return `${said} Then run /devspec-login to sign in again.`
  }
  return "DevSpec did not accept Antigravity's sign-in (it may have been revoked). Run /devspec-login to sign in again."
}
