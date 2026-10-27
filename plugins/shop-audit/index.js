// Observes the frozen FINAL outcome of every tool call (tools/result): what the model actually received.
import Schema from '@deepseek-ai/schemastery'
import { audit } from '../../lib/audit.mjs'

export const name = 'shop-audit'
export const Config = Schema.object({ auditFile: Schema.string().required() })

export function apply(ctx, config) {
  ctx.on('tools/result', (exec, result) => {
    const text = (result.content ?? []).map(b => (b.type === 'text' ? b.text : `[${b.type}]`)).join('')
    audit(config.auditFile, { event: 'tool/result', tool: exec.name, args: exec.arguments, isError: result.isError, model_saw: text })
  })
}
