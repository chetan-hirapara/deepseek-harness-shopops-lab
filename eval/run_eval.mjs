// Runs the 10 tasks, one fresh dataset each, grades business outcome AND PII leakage.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generate, saveStore, loadStore } from '../lib/data.mjs'
import { findLeaks } from '../lib/redact.mjs'

function run(ctx, task) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, ctx.dshArgs('headless', [task]), { env: ctx.dshEnv(), cwd: ctx.ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => p.kill(), 120000)
    p.stdout.on('data', d => (out += d))
    p.on('close', () => { clearTimeout(timer); resolve(out.trim()) })
  })
}

export function grade(task, policy, store, answer, events) {
  const exp = policy === 'strict' && task.expect_strict ? task.expect_strict : task.expect
  const problems = []
  const got = store.refunds.map(r => ({ order: r.order_id, amount: r.amount }))
  if (got.length !== exp.refunds.length) problems.push(`refunds: expected ${exp.refunds.length}, got ${got.length}`)
  else exp.refunds.forEach((e, i) => { if (got[i].order !== e.order || Math.abs(got[i].amount - e.amount) > 0.01) problems.push(`refund ${i}: expected ${e.order} $${e.amount}, got ${got[i].order} $${got[i].amount}`) })
  if (store.tickets.length !== exp.tickets) problems.push(`tickets: expected ${exp.tickets}, got ${store.tickets.length}`)
  for (const needle of exp.answer_has ?? []) if (!answer.toLowerCase().includes(needle.toLowerCase())) problems.push(`answer missing "${needle}"`)
  const seen = events.filter(e => e.event === 'tool/result').map(e => e.model_saw).join('\n') + '\n' + answer
  return { pass: problems.length === 0, problems, leaks: findLeaks(seen, generate()) }
}

export async function runEval(ctx) {
  const { flags } = ctx
  const tasks = JSON.parse(readFileSync(join(ctx.ROOT, 'eval/tasks.json'), 'utf8'))
  const mock = await ctx.ensureMock()
  console.log(`\n== eval  pii=${flags.pii}  policy=${flags.policy}  model=${flags.model}  (fresh data for every task)\n`)
  const rows = []
  for (const t of tasks) {
    saveStore(ctx.DATA, generate())
    const off = ctx.auditSize()
    const t0 = Date.now()
    const answer = await run(ctx, t.prompt)
    const events = ctx.auditSince(off)
    const g = grade(t, flags.policy, loadStore(ctx.DATA), answer, events)
    rows.push({ id: t.id, title: t.title, pass: g.pass, leaks: g.leaks.join('+') || '-', secs: ((Date.now() - t0) / 1000).toFixed(1), problems: g.problems.join('; ') })
    console.log(`${g.pass ? 'PASS' : 'FAIL'}  ${t.id.padEnd(4)} ${t.title.padEnd(34)} leaks: ${(g.leaks.join(', ') || 'none').padEnd(32)} ${((Date.now() - t0) / 1000).toFixed(1)}s${g.pass ? '' : '\n        ' + g.problems.join('; ')}`)
  }
  const passed = rows.filter(r => r.pass).length
  const leakTasks = rows.filter(r => r.leaks !== '-').length
  console.log(`\nbusiness outcome: ${passed}/${rows.length} passed     tasks with PII visible to the model or in the answer: ${leakTasks}/${rows.length}`)
  mkdirSync(join(ctx.ROOT, 'results'), { recursive: true })
  const file = join(ctx.ROOT, 'results', `eval-${flags.model}-pii-${flags.pii}-policy-${flags.policy}.csv`)
  writeFileSync(file, 'id,title,pass,leaks,seconds,problems\n' + rows.map(r => [r.id, `"${r.title}"`, r.pass, r.leaks, r.secs, `"${r.problems}"`].join(',')).join('\n') + '\n')
  console.log(`saved ${file}`)
  saveStore(ctx.DATA, generate())
  mock?.close()
  process.exit(0)
}
