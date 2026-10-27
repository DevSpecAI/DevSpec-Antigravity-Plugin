/**
 * A stand-in for DevSpec's MCP endpoint: keeps every tools/call it receives and
 * answers report_commit_provenance as the server does when it records a commit.
 */
import http from 'node:http'

export function startDevspec() {
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let rpc = {}
      try { rpc = JSON.parse(body) } catch { /* answered below */ }
      const name = rpc.params?.name ?? null
      const args = rpc.params?.arguments ?? {}
      if (rpc.method === 'tools/call') calls.push({ name, args })
      let result = { content: [{ type: 'text', text: '{}' }] }
      if (name === 'report_commit_provenance') {
        result = { content: [{ type: 'text', text: JSON.stringify({ recorded: true, status: 'inserted', commit_sha: args.commit_sha }) }] }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, result }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/api/mcp`, calls, close: () => server.close() }))
  })
}
