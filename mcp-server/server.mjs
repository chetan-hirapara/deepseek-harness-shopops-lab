// The same six ShopOps tools as an MCP stdio server, so ANY harness (Pi, Claude Code, Codex, OpenCode ...)
// can run the same ten tasks. Safety here is deliberately NOT built in: this is the "bare" tool surface,
// so you can compare where each harness lets you add PII masking and policy (experiment E9).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadStore, saveStore } from '../lib/data.mjs'
import { checkEligibility } from '../lib/policy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = process.env.SHOPOPS_DATA ?? join(ROOT, 'data/shop.json')
const text = v => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] })
const fail = msg => ({ isError: true, content: [{ type: 'text', text: `Error: ${msg}` }] })

const server = new McpServer({ name: 'shopops', version: '1.0.0' })

server.registerTool('lookup_order', {
  description: 'Look up an order by id (for example ORD-10001): status, dates, items, total, shipping city, customer id and notes.',
  inputSchema: { order_id: z.string() },
}, async ({ order_id }) => {
  const o = loadStore(DATA).orders.find(x => x.order_id === order_id)
  return o ? text(o) : fail(`Order ${order_id} not found`)
})

server.registerTool('get_customer', {
  description: 'Fetch a customer record by id (for example CUS-2001): name, email, phone, address, payment card, loyalty tier.',
  inputSchema: { customer_id: z.string() },
}, async ({ customer_id }) => {
  const c = loadStore(DATA).customers.find(x => x.customer_id === customer_id)
  return c ? text(c) : fail(`Customer ${customer_id} not found`)
})

server.registerTool('check_inventory', {
  description: 'Check stock for a SKU across warehouses, with the restock date when out of stock.',
  inputSchema: { sku: z.string(), warehouse: z.string().optional() },
}, async ({ sku, warehouse }) => {
  const s = loadStore(DATA)
  const p = s.products.find(x => x.sku === sku); const inv = s.inventory[sku]
  if (!p || !inv) return fail(`SKU ${sku} not found`)
  const stock = { 'warehouse-east': inv['warehouse-east'], 'warehouse-west': inv['warehouse-west'], 'warehouse-central': inv['warehouse-central'] }
  const total = warehouse ? (stock[warehouse] ?? 0) : Object.values(stock).reduce((a, b) => a + b, 0)
  return text({ sku, name: p.name, on_hand: warehouse ? { [warehouse]: stock[warehouse] ?? 0 } : stock, total, restock_date: total === 0 ? inv.restock_date : null })
})

server.registerTool('check_refund_eligibility', {
  description: 'Apply the refund rules to one order line. Always call before issue_refund.',
  inputSchema: { order_id: z.string(), sku: z.string(), reason: z.string().optional() },
}, async ({ order_id, sku }) => text(checkEligibility(loadStore(DATA), order_id, sku)))

server.registerTool('issue_refund', {
  description: 'Issue a refund for one order line. This moves money. Amount in dollars. Only after check_refund_eligibility says eligible.',
  inputSchema: { order_id: z.string(), sku: z.string(), amount: z.number(), reason: z.string() },
}, async ({ order_id, sku, amount, reason }) => {
  const s = loadStore(DATA)
  if (!s.orders.find(x => x.order_id === order_id)) return fail(`Order ${order_id} not found`)
  const refund = { refund_id: `RF-${String(s.refunds.length + 1).padStart(4, '0')}`, order_id, sku, amount, reason, at: new Date().toISOString() }
  s.refunds.push(refund); saveStore(DATA, s)
  return text({ refund_id: refund.refund_id, order_id, amount })
})

server.registerTool('create_ticket', {
  description: 'Open a ticket for a human agent when a request is blocked, not eligible, or needs approval.',
  inputSchema: { summary: z.string(), priority: z.string().optional() },
}, async ({ summary, priority }) => {
  const s = loadStore(DATA)
  const id = `TCK-${String(s.tickets.length + 1).padStart(4, '0')}`
  s.tickets.push({ ticket_id: id, summary, priority: priority ?? 'normal', at: new Date().toISOString() })
  saveStore(DATA, s)
  return text(id)
})

await server.connect(new StdioServerTransport())
console.error('[shopops-mcp] ready (6 tools)')
