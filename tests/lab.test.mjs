import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generate } from '../lib/data.mjs'
import { redact, buildDictionary, luhnOk, findLeaks, redactJson } from '../lib/redact.mjs'
import { checkEligibility, decide } from '../lib/policy.mjs'
import { decide as brain } from '../lib/mock-brain.mjs'
import { grade } from '../eval/run_eval.mjs'

const store = generate()
const dict = buildDictionary(store)
const cust = store.customers[0]

test('data is deterministic and synthetic', () => {
  assert.deepEqual(generate().customers[0], store.customers[0])
  assert.ok(store.customers.every(c => c.email.endsWith('@example.com')))
  assert.equal(store.orders.length, 60)
})

test('luhn accepts public test cards and rejects look-alikes', () => {
  assert.ok(luhnOk('4111111111111111'))
  assert.ok(!luhnOk('4111111111111112'))
})

test('regex mode masks emails, phones and cards but NOT names or addresses', () => {
  const out = redact(JSON.stringify(cust), 'regex', dict).text
  assert.ok(!out.includes(cust.email) && !out.includes(cust.phone) && !out.includes(cust.card_number))
  assert.ok(out.includes(cust.full_name), 'names leak in regex mode (that is the lesson)')
  assert.ok(out.includes(cust.address.split(',')[0]), 'addresses leak in regex mode')
})

test('dictionary mode also masks names and addresses', () => {
  const out = redact(JSON.stringify(cust), 'dictionary', dict).text
  assert.deepEqual(findLeaks(out, store), [])
})

test('off mode changes nothing; masking is deterministic', () => {
  const s = JSON.stringify(cust)
  assert.equal(redact(s, 'off', dict).text, s)
  assert.equal(redact(s, 'regex', dict).text, redact(s, 'regex', dict).text)
})

test('card with spaces in free text is masked without eating neighbouring words', () => {
  const t = 'refund to card 4111 1111 1111 1111 immediately'
  assert.equal(redact(t, 'regex', []).text.endsWith(' immediately'), true)
  assert.ok(!redact(t, 'regex', []).text.includes('4111'))
})

test('redactJson walks nested values', () => {
  const o = redactJson({ a: [{ e: cust.email }] }, 'regex', [])
  assert.ok(!JSON.stringify(o).includes(cust.email))
})

test('eligibility rules', () => {
  assert.equal(checkEligibility(store, 'ORD-10001', 'SKU-1002').eligible, true)
  assert.deepEqual(checkEligibility(store, 'ORD-10003', 'SKU-1005').rule_ids, ['R2'])
  assert.deepEqual(checkEligibility(store, 'ORD-10004', 'SKU-1001').rule_ids, ['R3'])
  assert.deepEqual(checkEligibility(store, 'ORD-10002', 'SKU-1007').rule_ids, ['R1'])
})

test('policy: lenient denies ineligible and over-limit, strict asks above $50', () => {
  const lenient = { mode: 'lenient', autoLimit: 200 }
  const strict = { mode: 'strict', askAbove: 50, hardCap: 500 }
  const bad = { order_id: 'ORD-10005', sku: 'SKU-1010', amount: 55 }
  assert.equal(decide(store, 'issue_refund', bad, lenient).kind, 'deny')
  const big = { order_id: 'ORD-10006', sku: 'SKU-1003', amount: 180 }
  assert.equal(decide(store, 'issue_refund', big, lenient).kind, 'allow')
  assert.equal(decide(store, 'issue_refund', big, strict).kind, 'ask')
  assert.equal(decide(store, 'issue_refund', { ...big, amount: 999 }, strict).kind, 'deny')
  assert.equal(decide(store, 'lookup_order', {}, strict).kind, 'allow')
})

test('mock brain: refund playbook asks for eligibility first, gullible mode follows injected notes', () => {
  const msgs = [{ role: 'user', content: 'Please refund ORD-10001' }]
  assert.equal(brain(msgs).name, 'lookup_order')
  const withTools = (name, args, content, id) => [{ role: 'assistant', tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] }, { role: 'tool', tool_call_id: id, content }]
  const order = JSON.stringify(store.orders.find(o => o.order_id === 'ORD-10005'))
  const m2 = [...msgs, ...withTools('lookup_order', {}, order, 'a'), ...withTools('get_customer', {}, JSON.stringify(cust), 'b')]
  assert.equal(brain([{ role: 'user', content: 'Please refund ORD-10005' }, ...m2.slice(1)], { gullible: true }).name, 'issue_refund')
  assert.equal(brain([{ role: 'user', content: 'Please refund ORD-10005' }, ...m2.slice(1)], { gullible: false }).name, 'check_refund_eligibility')
})

test('grader flags wrong outcomes and leaks', () => {
  const task = { expect: { refunds: [], tickets: 1 } }
  const bad = { refunds: [{ order_id: 'ORD-10005', amount: 55 }], tickets: [] }
  assert.equal(grade(task, 'lenient', bad, 'done', []).pass, false)
  assert.deepEqual(grade({ expect: { refunds: [], tickets: 0 } }, 'lenient', { refunds: [], tickets: [] }, cust.email, []).leaks, ['email'])
})
