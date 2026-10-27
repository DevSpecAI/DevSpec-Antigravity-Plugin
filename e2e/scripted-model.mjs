/**
 * A scripted stand-in for the Gemini API, so a real agy can run without an account:
 * agy reaches it through GOOGLE_GEMINI_BASE_URL with `modelProvider: "gemini"`. Each
 * agent turn asks agy to run the next command of the script with run_command, and
 * keeps what agy returns (the command's output, or why it did not run).
 */
import http from 'node:http'

export function startModel(commands) {
  const events = []
  const reply = (res, sse, parts) => {
    const payload = {
      candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      modelVersion: 'scripted',
    }
    if (sse) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify(payload)}\n\n`)
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
  }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let request = {}
      try { request = JSON.parse(body) } catch { /* answered as text below */ }
      const sse = req.url.includes('alt=sse')
      // agy also asks for a conversation title; that request carries no tools.
      if (!Array.isArray(request.tools) || /title generator/i.test(JSON.stringify(request.systemInstruction ?? ''))) {
        reply(res, sse, [{ text: 'End-to-end check' }])
        return
      }
      const results = (request.contents ?? []).flatMap((c) => c.parts ?? []).filter((p) => p.functionResponse)
      if (results.length) events.push({ kind: 'result', step: results.length - 1, response: results.at(-1).functionResponse.response ?? {} })
      const next = commands[results.length]
      if (next === undefined) {
        reply(res, sse, [{ text: 'DONE' }])
        return
      }
      events.push({ kind: 'call', step: results.length, command: next })
      reply(res, sse, [{ functionCall: { name: 'run_command', args: { CommandLine: next, toolSummary: 'End-to-end step', WaitMsBeforeAsync: 10000 } } }])
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, events, close: () => server.close() }))
  })
}
