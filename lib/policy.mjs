// Refund rules (pure functions, shared by the tools plugin and the policy plugin).
import { TODAY, RETURN_WINDOW_DAYS } from './data.mjs'

const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000)

/** Business rules: what is this order line eligible for? */
export function checkEligibility(store, orderId, sku) {
  const order = store.orders.find(o => o.order_id === orderId)
  if (!order) return { eligible: false, max_amount: 0, rule_ids: ['R0'], explanation: `Order ${orderId} not found.` }
  const line = order.items.find(i => i.sku === sku)
  if (!line) return { eligible: false, max_amount: 0, rule_ids: ['R0'], explanation: `SKU ${sku} is not on order ${orderId}.` }
  const product = store.products.find(p => p.sku === sku)
  const rules = []
  if (order.status !== 'delivered') rules.push(['R1', 'Only delivered orders can be refunded.'])
  if (product.final_sale) rules.push(['R2', 'Final-sale items cannot be refunded.'])
  if (order.delivered_date) {
    const age = dayDiff(TODAY, order.delivered_date)
    const window = RETURN_WINDOW_DAYS[product.category] ?? 30
    if (age > window) rules.push(['R3', `Delivered ${age} days ago; the ${product.category} return window is ${window} days.`])
  }
  const alreadyRefunded = store.refunds.filter(r => r.order_id === orderId && r.sku === sku).reduce((s, r) => s + r.amount, 0)
  const lineTotal = Math.round(line.qty * line.unit_price * 100) / 100
  const max = Math.max(0, Math.round((lineTotal - alreadyRefunded) * 100) / 100)
  if (max <= 0) rules.push(['R4', 'This line has already been fully refunded.'])
  if (rules.length) return { eligible: false, max_amount: 0, rule_ids: rules.map(r => r[0]), explanation: rules.map(r => r[1]).join(' ') }
  return { eligible: true, max_amount: max, rule_ids: ['OK'], explanation: `Eligible for up to $${max.toFixed(2)}.` }
}

export const POLICY_MODES = ['lenient', 'strict']

/**
 * Decide what to do with a tool call. Returns a dsh PreToolDecision.
 *  lenient: refunds up to autoLimit are allowed, anything above is denied outright.
 *  strict : refunds up to askAbove are allowed, up to hardCap need a human approval, anything above is denied.
 *  both   : never refund more than eligibility allows, never to a card number typed into a note.
 */
export function decide(store, name, args, cfg) {
  if (name !== 'issue_refund') return { kind: 'allow' }
  const { order_id, sku, amount } = args ?? {}
  const el = checkEligibility(store, order_id, sku)
  if (!el.eligible) return { kind: 'deny', reason: `Policy: not eligible (${el.rule_ids.join(', ')}). ${el.explanation} Create a ticket instead.` }
  if (typeof amount !== 'number' || amount <= 0) return { kind: 'deny', reason: 'Policy: refund amount must be a positive number.' }
  if (amount > el.max_amount + 0.001) return { kind: 'deny', reason: `Policy: requested $${amount.toFixed(2)} exceeds the eligible maximum $${el.max_amount.toFixed(2)}.` }
  if (cfg.mode === 'strict') {
    if (amount > cfg.hardCap) return { kind: 'deny', reason: `Policy: refunds above $${cfg.hardCap} are never automatic. Create a ticket.` }
    if (amount > cfg.askAbove) return { kind: 'ask', reason: `Refund of $${amount.toFixed(2)} on ${order_id} needs human approval (limit $${cfg.askAbove}).` }
    return { kind: 'allow' }
  }
  if (amount > cfg.autoLimit) return { kind: 'deny', reason: `Policy: refunds above $${cfg.autoLimit} need a manager. Create a ticket.` }
  return { kind: 'allow' }
}
