// OpenAI-compatible /v1/chat/completions server backed by lib/mock-brain.mjs. Streams SSE.
import { createServer } from 'node:http'
import { decide } from '../lib/mock-brain.mjs'

const PORT = Number(process.env.MOCK_PORT ?? 8787)
const GULLIBLE = process.env.MOCK_GULLIBLE !== '0'
let seq = 0

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
const base = (id, extra) => ({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'shopops-mock', ...extra })

export function startMock(port = PORT) {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/health')) { res.end('ok'); return }
    if (req.method === 'GET' && req.url?.includes('/models')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'shopops-mock', object: 'model' }] }))
      return
    }
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) { res.statusCode = 404; res.end('not found'); return }
    let body = ''
    req.on('data', d => (body += d))
    req.on('end', () => {
      const payload = JSON.parse(body || '{}')
      const stream = payload.stream === true
      const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0
      const id = `chatcmpl-mock-${++seq}`
      // requests with no tools are side jobs (e.g. session titles): answer briefly
      const step = hasTools ? decide(payload.messages ?? [], { gullible: GULLIBLE }) : { type: 'text', content: 'ShopOps order help' }
      if (process.env.MOCK_VERBOSE) console.error(`[mock] ${step.type === 'tool_call' ? 'call ' + step.name + ' ' + JSON.stringify(step.args) : 'say  ' + step.content.slice(0, 90)}`)
      // other harnesses may expose tools with a prefix (for example Pi: mcp__shopops__lookup_order)
      if (step.type === 'tool_call') { const real = (payload.tools ?? []).map(t => t.function?.name ?? t.name).find(n => n === step.name || n?.endsWith('__' + step.name)); if (real) step.name = real }
      const toolCall = step.type === 'tool_call' ? [{ index: 0, id: `call_${seq}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] : null
      const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
      if (!stream) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'shopops-mock',
          choices: [{ index: 0, finish_reason: toolCall ? 'tool_calls' : 'stop', message: { role: 'assistant', content: toolCall ? null : step.content, ...(toolCall ? { tool_calls: toolCall.map(({ index, ...t }) => t) } : {}) } }], usage }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      sse(res, base(id, { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }))
      if (toolCall) {
        sse(res, base(id, { choices: [{ index: 0, delta: { tool_calls: toolCall }, finish_reason: null }] }))
      } else {
        const words = step.content.split(/(?<= )/)
        for (let i = 0; i < words.length; i += 4) sse(res, base(id, { choices: [{ index: 0, delta: { content: words.slice(i, i + 4).join('') }, finish_reason: null }] }))
      }
      sse(res, base(id, { choices: [{ index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }], usage }))
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMock().then(() => console.error(`[mock-llm] listening on http://127.0.0.1:${PORT}/v1  (gullible=${GULLIBLE})`))
}
