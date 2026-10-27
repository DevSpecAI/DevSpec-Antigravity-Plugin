/**
 * Runs a real agy against the scripted model, with this checkout installed as a
 * plugin in a throwaway home folder, and reports what happened to each command.
 * Nothing here touches the person's own agy settings, plugins or DevSpec state.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startModel } from './scripted-model.mjs'

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PROJECT_ID = '24c4abaa-2cb9-496a-8492-cf1f1aa1090b'
export const CONNECTION_ID = '7e57c0de-0000-4000-8000-00000000e2e0'
export const TASK_ID = '6da10a3a-5fcd-43f7-adcf-ab9cf52d1f9d'
export const PROJECT_REMOTE = 'https://github.com/DevSpecAI/e2e-fixture.git'

const PLUGIN_ENTRIES = ['hooks.json', 'plugin.json', 'package.json', 'rules', 'scripts', 'skills', 'sidecars']

/** A fresh home folder with agy pointed at the scripted model, and optionally this plugin installed. */
export function makeHome(root, { plugin = true, settings = {} } = {}) {
  const home = path.join(root, 'home')
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true })
  fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ modelProvider: 'gemini', ...settings }, null, 2))
  let pluginDir = null
  if (plugin) {
    pluginDir = path.join(home, '.gemini', 'config', 'plugins', 'devspec')
    for (const entry of PLUGIN_ENTRIES) {
      fs.cpSync(path.join(REPO, entry), path.join(pluginDir, entry), {
        recursive: true,
        filter: (source) => !source.endsWith('.test.mjs'),
      })
    }
  }
  return { home, pluginDir }
}

/** A git repository to work in, with the project's remote and no pin. */
export function makeRepo(root) {
  const repo = path.join(root, 'work')
  fs.mkdirSync(repo, { recursive: true })
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'DevSpec e2e')
  git('config', 'user.email', 'e2e@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('remote', 'add', 'origin', PROJECT_REMOTE)
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.agents/\n')
  git('commit', '-q', '--allow-empty', '-m', 'start')
  return { repo, git }
}

/**
 * A workspace hook (test fixture, not plugin code) that binds the agy conversation to a
 * DevSpec connection served by the stand-in, records the project's repositories, and
 * notes one claimed task the way claim_work_item's PostToolUse does.
 */
export function bindConversation(workspace, pluginDir, devspecUrl, { claim = true } = {}) {
  const agents = path.join(workspace, '.agents')
  fs.mkdirSync(agents, { recursive: true })
  const repositories = `<devspec-repository-data>${JSON.stringify({
    project_id: PROJECT_ID,
    status: 'available',
    repositories: [{ full_name: 'DevSpecAI/e2e-fixture', provider: 'github', git_url: PROJECT_REMOTE }],
  })}</devspec-repository-data>`
  fs.writeFileSync(path.join(agents, 'bind.mjs'), `// Test fixture: bind this conversation to the stand-in DevSpec.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
const dir = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')
fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value), { mode: 0o600 })
write(${JSON.stringify(`${CONNECTION_ID}.json`)}, {
  connection_id: ${JSON.stringify(CONNECTION_ID)}, enabled: true, agent_name: 'Antigravity', local_id: input.conversationId,
  project_id: ${JSON.stringify(PROJECT_ID)}, token: 'dvs_e2e_not_a_secret', mcp_url: ${JSON.stringify(devspecUrl)},
  connection_capability: 'e2e-capability',
})
write(${JSON.stringify(`${CONNECTION_ID}.repositories.json`)}, { project_id: ${JSON.stringify(PROJECT_ID)}, text: ${JSON.stringify(repositories)} })
if (${JSON.stringify(claim)}) {
  const { handlePost } = await import(${JSON.stringify(pathToFileURL(path.join(pluginDir, 'scripts', 'commit-provenance.mjs')).href)})
  handlePost({ conversationId: input.conversationId, workspacePaths: input.workspacePaths, tool_name: 'mcp_devspec_claim_work_item',
    tool_input: { task_id: ${JSON.stringify(TASK_ID)} },
    tool_response: { content: [{ type: 'text', text: JSON.stringify({ id: ${JSON.stringify(TASK_ID)} }) }] } }, { env: process.env })
}
`)
  // agy runs hook commands through `cmd /c` on Windows, where a quoted path reaches node
  // with its quotes; workspace hooks run from this .agents folder, so a bare relative path.
  fs.writeFileSync(path.join(agents, 'hooks.json'), JSON.stringify({
    'e2e-fixture': { SessionStart: [{ type: 'command', command: 'node ./bind.mjs', timeout: 30 }] },
  }, null, 2))
}

/**
 * Run agy once in `workspace`, the model asking for each command in turn. Each step
 * comes back as `{ command, outcome, text, rewritten }`, outcome one of `ran` (agy ran
 * it), `denied` (a deny rule), `not-allowed` (it needed a permission prompt, which
 * headless agy refuses), `hook-failed` or `error`.
 */
export async function runAgy({ agy, home, workspace, commands, skipPermissions = false, timeoutMs = 240_000 }) {
  const model = await startModel(commands)
  const base = process.platform === 'win32' ? { ...process.env } : { PATH: process.env.PATH, TERM: 'dumb', LANG: 'C.UTF-8' }
  const env = {
    ...base,
    HOME: home,
    USERPROFILE: home,
    GEMINI_API_KEY: 'e2e-not-a-secret',
    GOOGLE_GEMINI_BASE_URL: model.url,
    DEVSPEC_CONNECT_AT_STARTUP: '0',
  }
  const args = ['-p', 'Run the end-to-end check', '--print-timeout', `${Math.floor(timeoutMs / 1000) - 20}s`]
  if (skipPermissions) args.push('--dangerously-skip-permissions')
  const run = await new Promise((resolve) => {
    const child = spawn(agy, args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(error) }) })
  })
  model.close()
  const steps = commands.map((command, step) => {
    const result = model.events.find((e) => e.kind === 'result' && e.step === step)
    const called = model.events.some((e) => e.kind === 'call' && e.step === step)
    if (!result) {
      const outcome = called && /cannot prompt for, so it was auto-denied/.test(run.stderr) ? 'not-allowed' : 'not-reached'
      return { command, outcome, text: '', rewritten: false }
    }
    const text = String(result.response.output ?? result.response.error ?? JSON.stringify(result.response))
    const outcome = /Command exited with code/.test(text)
      ? 'ran'
      : /deny rule/.test(text)
        ? 'denied'
        : /JSON hook .* failed/.test(text)
          ? 'hook-failed'
          : 'error'
    return { command, outcome, text, rewritten: /A pre-tool hook changed the arguments/.test(text) }
  })
  return { ...run, steps }
}
