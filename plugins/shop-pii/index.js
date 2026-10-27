// PII masking plugin. Two hook points (see slide 8 of the deck):
//   agent/pre-step      -> rewrite what the model will READ (the user prompt)
//   tools/post-execute  -> redact tool RESULTS before the model sees them
// Mode is swapped from YAML: off | regex | dictionary.
import Schema from '@deepseek-ai/schemastery'
import { loadStore } from '../../lib/data.mjs'
import { buildDictionary, redact } from '../../lib/redact.mjs'
import { audit } from '../../lib/audit.mjs'

export const name = 'shop-pii'
export const Config = Schema.object({
  mode: Schema.union(['off', 'regex', 'dictionary']).default('regex'),
  dataFile: Schema.string().required(),
  auditFile: Schema.string(),
})

export function apply(ctx, config) {
  // dictionary mode builds exact matches (names, addresses) from YOUR customer table
  const dictionary = config.mode === 'dictionary' ? buildDictionary(loadStore(config.dataFile)) : []
  console.error(`[shop-pii] mode=${config.mode}${config.mode === 'dictionary' ? ` (${dictionary.length} dictionary terms)` : ''}`)

  // outermost listener (prepend) so we see the FINAL messages other plugins produced
  ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (config.mode === 'off' || decision.kind !== 'enter') return decision
    let masked = 0
    const messages = decision.messages.map(m => ({
      ...m,
      content: m.content.map(b => {
        if (b.type !== 'text') return b
        const r = redact(b.text, config.mode, dictionary)
        masked += r.hits.length
        return r.hits.length ? { ...b, text: r.text } : b
      }),
    }))
    if (masked) audit(config.auditFile, { event: 'pii/prompt', mode: config.mode, masked })
    return { ...decision, messages }
  }, { prepend: true })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (config.mode === 'off' || decision.kind !== 'accept' || decision.value !== undefined) return decision
    const base = decision.content ?? result.content
    let masked = 0
    const content = base.map(b => {
      if (b.type !== 'text') return b
      const r = redact(b.text, config.mode, dictionary)
      masked += r.hits.length
      return r.hits.length ? { ...b, text: r.text } : b
    })
    if (masked) audit(config.auditFile, { event: 'pii/tool-result', tool: exec.name, mode: config.mode, masked })
    return { ...decision, content }
  }, { prepend: true })
}
