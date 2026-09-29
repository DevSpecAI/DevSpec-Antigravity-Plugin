/** Antigravity's mechanical Connect owns this credential-bearing operation. */
import { createHash } from 'node:crypto'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'
import { setupFromPlugin } from '../launcher/plugin-setup.mjs'
export async function setupAntigravityLauncher() {
  if (process.env.DEVSPEC_LAUNCHER_DISABLED === '1') return
  try {
    const auth = resolveDevspecMcpAuth()
    await setupFromPlugin({ account: auth.ok && auth.token && auth.mcp_url ? {
      fingerprint: createHash('sha256').update(auth.token).digest('hex'),
      endpoint: auth.mcp_url,
      verifyAccount: async publicKey => {
        const response = await fetch(new URL('/api/launcher/pair', auth.mcp_url), { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ publicKey }), signal: AbortSignal.timeout(15000) })
        if (!response.ok) throw new Error('Local launcher account pairing failed')
        return response.json()
      },
    } : undefined })
  } catch { /* preserve the connection result even if optional launcher setup fails */ }
}
