/**
 * The agy release the end-to-end tests run, pinned so a new agy cannot change the
 * result unnoticed. To move to a newer agy, take its URL and SHA-512 from
 * https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/<platform>.json
 * and run the tests on both platforms.
 */
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const AGY_RELEASE = {
  version: '1.4.8',
  linux_amd64: {
    url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.4.8-5447777392656384/linux-x64/cli_linux_x64.tar.gz',
    sha512: 'b23683771438e72bffe0a2231168f65a16a0d73ed2c7a8460b311dc5fe0c3c9d9dfc6cbfb7d8755173340071aa4cc5c7a552fb5d1be3fdd31c2b7559d67e404a',
    member: 'antigravity',
  },
  windows_amd64: {
    url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.4.8-5447777392656384/windows-x64/cli_windows_x64.exe',
    sha512: '9ea0ec4157540d6f9b9f3daabacee1abed4352987d3aa7294ca405cea483f7c733711281a5065e8412ae99d98d79525e80e47087a496152b723233f98658a78f',
  },
}

/** Download the pinned agy for this machine into `dir` (once), check it, and return its path. */
export async function fetchAgy(dir = path.join(os.tmpdir(), `devspec-agy-${AGY_RELEASE.version}`)) {
  const key = process.platform === 'win32' ? 'windows_amd64' : process.platform === 'linux' ? 'linux_amd64' : null
  if (!key || process.arch !== 'x64') throw new Error(`no pinned agy for ${process.platform}/${process.arch}`)
  const release = AGY_RELEASE[key]
  const binary = path.join(dir, process.platform === 'win32' ? 'agy.exe' : 'agy')
  if (fs.existsSync(binary)) return binary
  const response = await fetch(release.url)
  if (!response.ok) throw new Error(`agy download failed: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const sha = crypto.createHash('sha512').update(bytes).digest('hex')
  if (sha !== release.sha512) throw new Error(`agy download does not match its SHA-512 (${release.url})`)
  fs.mkdirSync(dir, { recursive: true })
  if (release.member) {
    const archive = path.join(dir, 'agy.tar.gz')
    fs.writeFileSync(archive, bytes)
    const untar = spawnSync('tar', ['-xzf', archive, '-C', dir, release.member], { encoding: 'utf8' })
    if (untar.status !== 0) throw new Error(`agy unpack failed: ${untar.stderr}`)
    fs.renameSync(path.join(dir, release.member), binary)
    fs.rmSync(archive, { force: true })
  } else {
    fs.writeFileSync(binary, bytes)
  }
  fs.chmodSync(binary, 0o755)
  return binary
}
