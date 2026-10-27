#!/usr/bin/env node
// ShopOps lab runner. Node only, works on macOS, Linux and Windows.
//   node lab.mjs setup                      generate data, check install
//   node lab.mjs check                      verify everything is ready
//   node lab.mjs run "Refund ORD-10001"     one task, headless, prints what the model saw
//   node lab.mjs web                        browser UI at http://127.0.0.1:3080
//   node lab.mjs eval                       run the 10 graded tasks
//   node lab.mjs playground                 PII + policy playground (no harness needed)
// Options: --pii off|regex|dictionary  --policy off|lenient|strict  --model mock|deepseek|litellm|ollama
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generate, saveStore, loadStore } from './lib/data.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/')
const DSH_BIN = join(ROOT, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const DATA = join(ROOT, 'data/shop.json')
const AUDIT = join(ROOT, '.runs/audit.jsonl')
const GEN = join(ROOT, '.generated')
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 8787)

const PII = ['off', 'regex', 'dictionary']
const POLICY = ['off', 'lenient', 'strict']
const MODEL = ['mock', 'deepseek', 'litellm', 'ollama']

// ---------- args ----------
const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'help'
const flags = { pii: 'off', policy: 'lenient', model: 'mock', extra: [] }
const rest = []
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--pii') flags.pii = argv[++i]
  else if (a === '--policy') flags.policy = argv[++i]
  else if (a === '--model') flags.model = argv[++i]
  else if (a === '--patch') flags.extra.push(resolve(argv[++i]))
  else if (a === '--port') flags.port = argv[++i]
  else rest.push(a)
}
const must = (name, v, allowed) => { if (!allowed.includes(v)) die(`--${name} must be one of: ${allowed.join(', ')} (got "${v}")`) }
function die(msg) { console.error(`\nERROR: ${msg}\n`); process.exit(1) }

// ---------- patches ----------
function render(file) {
  const src = join(ROOT, 'patches', file)
  if (!existsSync(src)) die(`patch file not found: patches/${file}`)
  const env = process.env
  const subs = {
    __ROOT__: ROOT,
    __MOCK_PORT__: String(MOCK_PORT),
    __TD_LITELLM_BASE_URL__: env.TD_LITELLM_BASE_URL ?? '',
    __TD_LITELLM_MODEL__: env.TD_LITELLM_MODEL ?? '',
    __OLLAMA_MODEL__: env.OLLAMA_MODEL ?? 'llama3.1',
  }
  let text = readFileSync(src, 'utf8')
  for (const [k, v] of Object.entries(subs)) text = text.split(k).join(v)
  if (text.includes('__')) {
    const left = [...new Set(text.match(/__[A-Z_]+__/g) ?? [])]
    if (left.length) die(`patches/${file} still has unfilled placeholders: ${left.join(', ')}`)
  }
  mkdirSync(GEN, { recursive: true })
  const out = join(GEN, file)
  writeFileSync(out, text)
  return out
}

function patchList() {
  must('pii', flags.pii, PII); must('policy', flags.policy, POLICY); must('model', flags.model, MODEL)
  if (flags.model === 'litellm' && (!process.env.TD_LITELLM_BASE_URL || !process.env.TD_LITELLM_MODEL)) die('--model litellm needs TD_LITELLM_BASE_URL, TD_LITELLM_KEY and TD_LITELLM_MODEL in your environment')
  if (flags.model === 'deepseek' && !process.env.DEEPSEEK_API_KEY) die('--model deepseek needs DEEPSEEK_API_KEY in your environment (headless does not read keys saved in the Web UI)')
  const files = ['base.yml', `pii-${flags.pii}.yml`, `policy-${flags.policy}.yml`, `model-${flags.model}.yml`]
  return [...files.map(render), ...flags.extra]
}

function dshEnv() {
  const home = join(ROOT, '.dsh-home')
  mkdirSync(home, { recursive: true })
  return { ...process.env, DSH_HOME: home, SHOPOPS_MOCK_KEY: process.env.SHOPOPS_MOCK_KEY ?? 'mock', OLLAMA_API_KEY: process.env.OLLAMA_API_KEY ?? 'ollama' }
}

function dshArgs(profile, extraArgs = []) {
  const patches = patchList().flatMap(p => ['--patch', p])
  return [DSH_BIN, '--profile', profile, ...patches, ...extraArgs]
}

// ---------- mock model ----------
async function healthy(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/health`); return r.ok } catch { return false }
}
async function ensureMock() {
  if (flags.model !== 'mock') return null
  if (await healthy(MOCK_PORT)) return null
  const { startMock } = await import('./mock-llm/server.mjs')
  const s = await startMock(MOCK_PORT)
  return s
}

// ---------- audit ----------
const auditSize = () => (existsSync(AUDIT) ? statSync(AUDIT).size : 0)
function auditSince(offset) {
  if (!existsSync(AUDIT)) return []
  return readFileSync(AUDIT, 'utf8').slice(offset).split('\n').filter(Boolean).map(l => JSON.parse(l))
}
function showAudit(events) {
  if (!events.length) { console.log('  (no audit events)'); return }
  for (const e of events) {
    if (e.event === 'tool/result') console.log(`  tool ${e.tool}(${JSON.stringify(e.args)})${e.isError ? '  ERROR' : ''}\n     model saw: ${e.model_saw.length > 360 ? e.model_saw.slice(0, 360) + ' ...' : e.model_saw}`)
    else if (e.event === 'policy/decision') console.log(`  POLICY ${e.decision.toUpperCase()} ${e.tool}: ${e.reason}`)
    else if (e.event?.startsWith('pii/')) console.log(`  PII masked ${e.masked} value(s) in ${e.event.split('/')[1]}${e.tool ? ' of ' + e.tool : ''} [${e.mode}]`)
  }
}

function runDsh(args, { inherit = true } = {}) {
  return new Promise(resolvePromise => {
    const p = spawn(process.execPath, args, { env: dshEnv(), cwd: ROOT, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    if (!inherit) { p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (err += d)) }
    p.on('close', code => resolvePromise({ code, out, err }))
  })
}

// ---------- commands ----------
async function cmdSetup() {
  if (Number(process.versions.node.split('.')[0]) < 22) die(`Node 22.19 or newer is required (you have ${process.versions.node})`)
  saveStore(DATA, generate())
  mkdirSync(join(ROOT, '.runs'), { recursive: true })
  console.log(`Generated ${DATA} (40 customers, 60 orders, 12 products). All data is synthetic.`)
  await cmdCheck()
}

async function cmdReset() {
  saveStore(DATA, generate())
  rmSync(AUDIT, { force: true })
  console.log('Data regenerated, refunds and tickets cleared, audit log removed.')
}

async function cmdCheck() {
  const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); return c }
  let good = true
  const major = Number(process.versions.node.split('.')[0])
  good = ok(major >= 22, `Node ${process.versions.node} (need 22.19+ or 24+)`) && good
  good = ok(existsSync(DSH_BIN), 'dsh installed (run `npm install` if this fails)') && good
  good = ok(existsSync(DATA), 'data/shop.json exists (run `node lab.mjs setup`)') && good
  if (existsSync(DSH_BIN)) {
    const v = spawnSync(process.execPath, [DSH_BIN, '--version'], { env: dshEnv(), encoding: 'utf8' })
    console.log(`INFO  dsh ${v.stdout.trim()} (pinned 0.2.1-rc.2)`)
  }
  const srv = await ensureMockForCheck()
  good = ok(srv, `mock model server starts on port ${MOCK_PORT}`) && good
  console.log(good ? '\nReady. Try: node lab.mjs run "Where is order ORD-10002?"' : '\nFix the FAIL lines above, then run `node lab.mjs check` again.')
  process.exit(good ? 0 : 1)
}
async function ensureMockForCheck() {
  if (await healthy(MOCK_PORT)) return true
  try { const { startMock } = await import('./mock-llm/server.mjs'); const s = await startMock(MOCK_PORT); s.close(); return true } catch { return false }
}

async function cmdRun() {
  const task = rest.join(' ').trim()
  if (!task) die('usage: node lab.mjs run "Refund ORD-10001 because it arrived late" [--pii regex] [--policy strict] [--model mock]')
  if (!existsSync(DATA)) die('run `node lab.mjs setup` first')
  const mock = await ensureMock()
  const off = auditSize()
  console.log(`\n== ShopOps run  pii=${flags.pii}  policy=${flags.policy}  model=${flags.model}\n== task: ${task}\n`)
  const r = await runDsh(dshArgs('headless', [task]), { inherit: false })
  console.log('--- what the model saw and what policy decided ---')
  showAudit(auditSince(off))
  console.log('\n--- final answer ---')
  console.log((r.out || '(no output)').trim())
  if (r.code !== 0 && process.env.LAB_DEBUG !== '0') console.log(`\n(dsh exited with code ${r.code}; set LAB_DEBUG=1 to see its stderr)`)
  if (process.env.LAB_DEBUG === '1') console.log('\n--- dsh stderr ---\n' + r.err)
  const store = loadStore(DATA)
  console.log(`\nrefunds on file: ${store.refunds.length}   tickets on file: ${store.tickets.length}   (node lab.mjs refunds)`)
  mock?.close()
  process.exit(0)
}

async function cmdWeb() {
  if (!existsSync(DATA)) die('run `node lab.mjs setup` first')
  await ensureMock()
  console.log(`\nStarting the dsh Web UI  pii=${flags.pii}  policy=${flags.policy}  model=${flags.model}`)
  console.log('Open http://127.0.0.1:3080, choose THIS folder as the workspace, and try the prompts in README.md.\n')
  const args = dshArgs('web', ['--no-open', ...(flags.port ? ['--port', flags.port] : [])])
  const p = spawn(process.execPath, args, { env: dshEnv(), cwd: ROOT, stdio: 'inherit' })
  p.on('close', code => process.exit(code ?? 0))
}

async function cmdEval() {
  const { runEval } = await import('./eval/run_eval.mjs')
  await runEval({ flags, ensureMock, dshArgs, dshEnv, ROOT, DATA, AUDIT, auditSize, auditSince })
}

async function cmdRefunds() {
  const s = loadStore(DATA)
  console.log('refunds:', JSON.stringify(s.refunds, null, 2))
  console.log('tickets:', JSON.stringify(s.tickets, null, 2))
}

async function cmdAudit() {
  showAudit(auditSince(0))
}

async function cmdMock() {
  process.env.MOCK_VERBOSE = '1'
  const { startMock } = await import('./mock-llm/server.mjs')
  await startMock(MOCK_PORT)
  console.error(`[mock-llm] http://127.0.0.1:${MOCK_PORT}/v1  (Ctrl+C to stop)`)
}

async function cmdPi() {
  // Cross-harness run (E9): the SAME tools through MCP, protected by harnesses/pi/shop-guard.ts, using Pi instead of dsh.
  const task = rest.join(' ').trim()
  if (!task) die('usage: node lab.mjs pi "Please refund ORD-10005" [--pii regex] [--policy lenient]   (mock model only)')
  must('pii', flags.pii, PII); must('policy', flags.policy, POLICY)
  const local = join(ROOT, 'node_modules/.bin', process.platform === 'win32' ? 'pi.cmd' : 'pi')
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pi'], { encoding: 'utf8' })
  const piBin = existsSync(local) ? local : (which.status === 0 ? which.stdout.split('\n')[0].trim() : null)
  if (!piBin) die('Pi is not installed. Run:  npm install --no-save @earendil-works/pi-coding-agent   then try again')
  const dir = join(GEN, 'pi-agent')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { 'shopops-mock': { name: 'ShopOps mock', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'mock', api: 'openai-completions', compat: { supportsDeveloperRole: false }, models: [{ id: 'shopops-mock', name: 'ShopOps mock', contextWindow: 128000, maxTokens: 4096 }] } } }, null, 2))
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { shopops: { command: process.execPath, args: [join(ROOT, 'mcp-server/server.mjs')], env: { SHOPOPS_DATA: DATA }, exposure: 'direct' } } }, null, 2))
  flags.model = 'mock'
  const mock = await ensureMock()
  console.log(`\n== Pi run  pii=${flags.pii}  policy=${flags.policy}  (same tools over MCP, guard = harnesses/pi/shop-guard.ts)\n== task: ${task}\n`)
  const env = { ...process.env, PI_CODING_AGENT_DIR: dir, SHOPOPS_PII: flags.pii, SHOPOPS_POLICY: flags.policy, SHOPOPS_DATA: DATA }
  const piArgs = ['-p', task, '--model', 'shopops-mock/shopops-mock', '-e', join(ROOT, 'harnesses/pi/shop-guard.ts'), '--no-session', '--offline', '-nbt', '-nc']
  const opts = { env, cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] }
  // Windows needs a shell for pi.cmd, and the shell does not quote args, so quote them ourselves.
  const q = s => `"${String(s).replace(/["%]/g, '')}"`
  const p = process.platform === 'win32'
    ? spawn([piBin, ...piArgs].map(q).join(' '), { ...opts, shell: true })
    : spawn(piBin, piArgs, opts)
  p.on('close', () => { const s = loadStore(DATA); console.log(`\nrefunds on file: ${s.refunds.length}   tickets on file: ${s.tickets.length}`); mock?.close(); process.exit(0) })
}

async function cmdPlayground() {
  const { startPlayground } = await import('./playground/server.mjs')
  await startPlayground({ dataFile: DATA, port: Number(flags.port ?? 3090) })
}

const help = `
ShopOps lab
  node lab.mjs setup | check | reset
  node lab.mjs run "<task>"   [--pii off|regex|dictionary] [--policy off|lenient|strict] [--model mock|deepseek|litellm|ollama]
  node lab.mjs web            same options, browser UI on http://127.0.0.1:3080
  node lab.mjs eval           run the 10 graded tasks with the options above
  node lab.mjs playground     interactive PII + policy playground on http://127.0.0.1:3090
  node lab.mjs pi "<task>"    same tools via MCP in the Pi harness with a Pi extension guard (mock model)
  node lab.mjs refunds | audit | mock
`
const table = { setup: cmdSetup, check: cmdCheck, reset: cmdReset, run: cmdRun, web: cmdWeb, eval: cmdEval, refunds: cmdRefunds, audit: cmdAudit, mock: cmdMock, playground: cmdPlayground, pi: cmdPi }
if (!table[cmd]) { console.log(help); process.exit(cmd === 'help' ? 0 : 1) }
await table[cmd]()
