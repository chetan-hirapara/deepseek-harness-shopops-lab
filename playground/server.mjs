// Zero-dependency local playground: see what a model would receive under each PII mode,
// and what the refund policy would decide. Uses the SAME lib/ code as the dsh plugins.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadStore } from '../lib/data.mjs'
import { buildDictionary, redact, findLeaks, MODES } from '../lib/redact.mjs'
import { checkEligibility, decide } from '../lib/policy.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

export async function startPlayground({ dataFile, port = 3090 }) {
  const store = loadStore(dataFile)
  const dict = buildDictionary(store)
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(readFileSync(join(HERE, 'index.html'), 'utf8'))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/orders') {
      return json(res, 200, store.orders.slice(0, 10).map(o => ({ order_id: o.order_id, status: o.status, total: o.total, note: o.notes ? 'has notes' : '' })))
    }
    if (req.method === 'GET' && url.pathname === '/api/order') {
      const o = store.orders.find(x => x.order_id === url.searchParams.get('id'))
      if (!o) return json(res, 404, { error: 'unknown order' })
      const c = store.customers.find(x => x.customer_id === o.customer_id)
      return json(res, 200, { order: JSON.stringify(o, null, 2), customer: JSON.stringify(c, null, 2), items: o.items })
    }
    if (req.method === 'POST') {
      let body = ''
      req.on('data', d => (body += d))
      req.on('end', () => {
        let p
        try { p = JSON.parse(body || '{}') } catch { return json(res, 400, { error: 'bad json' }) }
        if (url.pathname === '/api/redact') {
          const mode = MODES.includes(p.mode) ? p.mode : 'regex'
          const r = redact(String(p.text ?? ''), mode, dict)
          return json(res, 200, { text: r.text, hits: r.hits.map(h => h.kind), leaks: findLeaks(r.text, store) })
        }
        if (url.pathname === '/api/policy') {
          const mode = ['lenient', 'strict', 'off'].includes(p.mode) ? p.mode : 'lenient'
          const args = { order_id: p.order_id, sku: p.sku, amount: Number(p.amount) }
          const elig = checkEligibility(store, args.order_id, args.sku)
          const decision = mode === 'off' ? { kind: 'allow', reason: 'no policy plugin loaded: the tool just runs' } : decide(store, 'issue_refund', args, { mode, autoLimit: 200, askAbove: 50, hardCap: 500 })
          return json(res, 200, { eligibility: elig, decision })
        }
        json(res, 404, { error: 'not found' })
      })
      return
    }
    res.writeHead(404); res.end('not found')
  })
  await new Promise(r => server.listen(port, '127.0.0.1', r))
  console.log(`\nPlayground running at http://127.0.0.1:${port}   (Ctrl+C to stop)\nSynthetic data only. Nothing here calls a model.\n`)
  return server
}
