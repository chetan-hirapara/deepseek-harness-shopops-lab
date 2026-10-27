// ShopOps tools: six order-operations tools over a local JSON store (data/shop.json).
// Tools hold NO policy on purpose: PII masking and refund rules live in separate plugins.
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadStore, saveStore } from '../../lib/data.mjs'
import { checkEligibility } from '../../lib/policy.mjs'

export const name = 'shop-tools'
export const inject = ['tools']
export const Config = Schema.object({
  dataFile: Schema.string().required(),
})

const asText = (_args, value) => [{ type: 'text', text: value }]
const out = { schema: { type: 'string' }, render: asText }

export function apply(ctx, config) {
  const reg = def => ctx.tools.register(defineTool(def))
  const j = v => JSON.stringify(v)

  reg({
    name: 'lookup_order',
    description: 'Look up an order by id (for example ORD-10001). Returns status, dates, items, total, shipping city, customer id and notes.',
    parameters: { order_id: { type: 'string', required: true, description: 'Order id such as ORD-10001' } },
    output: out,
    async execute({ order_id }) {
      const o = loadStore(config.dataFile).orders.find(x => x.order_id === order_id)
      if (!o) throw new Error(`Order ${order_id} not found`)
      return j(o)
    },
  })

  reg({
    name: 'get_customer',
    description: 'Fetch a customer record by customer id (for example CUS-2001): name, email, phone, address, payment card and loyalty tier.',
    parameters: { customer_id: { type: 'string', required: true, description: 'Customer id such as CUS-2001' } },
    output: out,
    async execute({ customer_id }) {
      const c = loadStore(config.dataFile).customers.find(x => x.customer_id === customer_id)
      if (!c) throw new Error(`Customer ${customer_id} not found`)
      return j(c)
    },
  })

  reg({
    name: 'check_inventory',
    description: 'Check stock for a SKU across warehouses, including the restock date when it is out of stock.',
    parameters: {
      sku: { type: 'string', required: true, description: 'SKU such as SKU-1001' },
      warehouse: { type: 'string', description: 'Optional: warehouse-east, warehouse-west or warehouse-central' },
    },
    output: out,
    async execute({ sku, warehouse }) {
      const s = loadStore(config.dataFile)
      const p = s.products.find(x => x.sku === sku)
      const inv = s.inventory[sku]
      if (!p || !inv) throw new Error(`SKU ${sku} not found`)
      const stock = { 'warehouse-east': inv['warehouse-east'], 'warehouse-west': inv['warehouse-west'], 'warehouse-central': inv['warehouse-central'] }
      const total = warehouse ? (stock[warehouse] ?? 0) : Object.values(stock).reduce((a, b) => a + b, 0)
      return j({ sku, name: p.name, on_hand: warehouse ? { [warehouse]: stock[warehouse] ?? 0 } : stock, total, restock_date: total === 0 ? inv.restock_date : null })
    },
  })

  reg({
    name: 'check_refund_eligibility',
    description: 'Apply the refund rules to one order line. Returns eligible, max_amount, rule ids and an explanation. Always call this before issue_refund.',
    parameters: {
      order_id: { type: 'string', required: true },
      sku: { type: 'string', required: true },
      reason: { type: 'string', description: 'Why the customer wants a refund' },
    },
    output: out,
    async execute({ order_id, sku }) {
      return j(checkEligibility(loadStore(config.dataFile), order_id, sku))
    },
  })

  reg({
    name: 'issue_refund',
    description: 'Issue a refund for one order line. This moves money. Amount is in dollars. Only call after check_refund_eligibility says eligible.',
    parameters: {
      order_id: { type: 'string', required: true },
      sku: { type: 'string', required: true },
      amount: { type: 'number', required: true, description: 'Dollars to refund' },
      reason: { type: 'string', required: true },
    },
    output: out,
    async execute({ order_id, sku, amount, reason }) {
      const s = loadStore(config.dataFile)
      if (!s.orders.find(x => x.order_id === order_id)) throw new Error(`Order ${order_id} not found`)
      const refund = { refund_id: `RF-${String(s.refunds.length + 1).padStart(4, '0')}`, order_id, sku, amount, reason, at: new Date().toISOString() }
      s.refunds.push(refund)
      saveStore(config.dataFile, s)
      return j({ refund_id: refund.refund_id, order_id, amount })
    },
  })

  reg({
    name: 'create_ticket',
    description: 'Open a ticket for a human agent. Use when a request is blocked, not eligible, or needs approval.',
    parameters: {
      summary: { type: 'string', required: true },
      priority: { type: 'string', description: 'low, normal or high' },
    },
    output: out,
    async execute({ summary, priority }) {
      const s = loadStore(config.dataFile)
      const id = `TCK-${String(s.tickets.length + 1).padStart(4, '0')}`
      s.tickets.push({ ticket_id: id, summary, priority: priority ?? 'normal', at: new Date().toISOString() })
      saveStore(config.dataFile, s)
      return id
    },
  })
}
