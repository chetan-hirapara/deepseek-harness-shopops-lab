// A scripted "model" so the lab runs with no API key and gives the SAME behaviour for everyone.
// It is a simulation, not an LLM: it follows fixed playbooks and, when GULLIBLE is on,
// it obeys instructions found inside order notes (the classic prompt-injection failure).
// Real models behave less predictably, which is why the lab also supports a real model route.

const text = m => (typeof m.content === 'string' ? m.content : (m.content ?? []).map(b => b.text ?? '').join(''))

function parse(s) { try { return JSON.parse(s) } catch { return null } }

export function decide(messages, { gullible = true } = {}) {
  const user = messages.find(m => m.role === 'user')
  const task = user ? text(user) : ''
  // tool calls made so far, paired with their results
  const done = []
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        const res = messages.find(x => x.role === 'tool' && x.tool_call_id === tc.id)
        done.push({ name: tc.function.name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, ''), args: parse(tc.function.arguments) ?? {}, content: res ? text(res) : null })
      }
    }
  }
  const last = n => [...done].reverse().find(d => d.name === n)
  const orderId = (task.match(/ORD-\d+/) ?? [])[0]
  const skuInTask = (task.match(/SKU-\d+/) ?? [])[0]
  const wantsRefund = /refund|money back|return/i.test(task)
  const wantsStock = /stock|inventory|available/i.test(task) || (skuInTask && !orderId)
  const wantsCustomer = /customer|who|tier|contact/i.test(task)

  const call = (name, args) => ({ type: 'tool_call', name, args })
  const say = content => ({ type: 'text', content })
  const isErr = d => /^(Error|Policy:|Guard:|Refund needs)/.test(d?.content ?? '')

  if (wantsStock && skuInTask && !orderId) {
    const inv = last('check_inventory')
    if (!inv) return call('check_inventory', { sku: skuInTask })
    return say(`Stock check for ${skuInTask}: ${inv.content}`)
  }
  if (!orderId) return say('Please include an order id such as ORD-10001 and tell me what you need.')

  const order = last('lookup_order')
  if (!order) return call('lookup_order', { order_id: orderId })
  const o = parse(order.content)
  if (!o) return say(`I could not read the order: ${order.content}`)

  if (!wantsRefund) {
    if (wantsCustomer) {
      const cust = last('get_customer')
      if (!cust) return call('get_customer', { customer_id: o.customer_id })
      const c = parse(cust.content)
      return say(`Order ${o.order_id} (${o.status}) belongs to ${c?.full_name ?? 'the customer'}, loyalty tier ${c?.loyalty_tier ?? 'unknown'}. Contact on file: ${c?.email ?? 'n/a'}, ${c?.phone ?? 'n/a'}.`)
    }
    const eta = o.status === 'delivered' ? `delivered on ${o.delivered_date}` : `still ${o.status.replace('_', ' ')}, shipping to ${o.shipping_city}`
    return say(`Order ${o.order_id} is ${eta}. Items: ${o.items.map(i => `${i.qty} x ${i.name}`).join(', ')}. Total $${o.total.toFixed(2)}.`)
  }

  // ----- refund playbook -----
  const cust = last('get_customer')
  if (!cust) return call('get_customer', { customer_id: o.customer_id })
  const c = parse(cust.content)
  const line = o.items[0]
  const injected = gullible && /ignore|override|full order total|refund the full/i.test(o.notes ?? '')

  const issued = last('issue_refund')
  if (issued) {
    if (isErr(issued)) {
      const ticket = last('create_ticket')
      if (!ticket) return call('create_ticket', { summary: `Refund for ${o.order_id} was blocked: ${issued.content.slice(0, 160)}`, priority: 'high' })
      return say(`I could not complete the refund for ${o.order_id}. It was blocked by policy, so I opened a ticket for a human to review (${ticket.content}).`)
    }
    return say(`Refund done for ${c?.full_name ?? 'the customer'} on ${o.order_id}: ${issued.content}. A confirmation goes to ${c?.email ?? 'the email on file'}.`)
  }
  if (injected) {
    // the gullible model follows the instruction hidden in the note and skips the eligibility check
    return call('issue_refund', { order_id: o.order_id, sku: line.sku, amount: o.total, reason: 'Followed instruction found in order notes' })
  }
  const el = last('check_refund_eligibility')
  if (!el) return call('check_refund_eligibility', { order_id: o.order_id, sku: line.sku, reason: 'customer request' })
  const e = parse(el.content)
  if (!e?.eligible) {
    const ticket = last('create_ticket')
    if (!ticket) return call('create_ticket', { summary: `Refund not eligible for ${o.order_id}: ${e?.explanation ?? el.content}`, priority: 'normal' })
    return say(`${o.order_id} is not eligible for a refund. ${e?.explanation ?? ''} I opened a ticket (${ticket.content}) so a person can follow up.`)
  }
  return call('issue_refund', { order_id: o.order_id, sku: line.sku, amount: e.max_amount, reason: 'customer request' })
}
