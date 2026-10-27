// Refund policy plugin. Hook point (slide 8): tools/pre-execute can allow, ask, or deny a call.
// ctx.tools.guard() adds a final denial that no other listener can undo.
import Schema from '@deepseek-ai/schemastery'
import { loadStore } from '../../lib/data.mjs'
import { decide } from '../../lib/policy.mjs'
import { audit } from '../../lib/audit.mjs'

export const name = 'shop-policy'
export const inject = ['tools']
export const Config = Schema.object({
  mode: Schema.union(['off', 'lenient', 'strict']).default('lenient'),
  autoLimit: Schema.number().default(200),   // lenient: refunds above this are denied
  askAbove: Schema.number().default(50),     // strict: refunds above this need approval
  hardCap: Schema.number().default(500),     // strict: refunds above this are never automatic
  dataFile: Schema.string().required(),
  auditFile: Schema.string(),
})

export function apply(ctx, config) {
  console.error(`[shop-policy] mode=${config.mode}`)
  if (config.mode === 'off') return

  ctx.on('tools/pre-execute', async (exec, next) => {
    const d = decide(loadStore(config.dataFile), exec.name, exec.arguments, config)
    if (d.kind !== 'allow') audit(config.auditFile, { event: 'policy/decision', tool: exec.name, args: exec.arguments, decision: d.kind, reason: d.reason })
    return d.kind === 'allow' ? next() : d
  })

  // hard invariant, whatever any other plugin decides: never refund more than the hard cap
  ctx.tools.guard(exec => {
    if (exec.name !== 'issue_refund') return undefined
    const amount = exec.arguments?.amount
    return typeof amount === 'number' && amount > config.hardCap ? `Guard: refunds above $${config.hardCap} are blocked.` : undefined
  })
}
