// PII redaction used by the dsh plugin (plugins/shop-pii) AND the playground.
// Three modes, so the lab can show what each one catches and misses:
//   off        -> nothing is masked
//   regex      -> emails, phones, SSNs, API keys, and card numbers that pass the Luhn check
//   dictionary -> regex PLUS exact matches of customer names and street addresses from your own tables
import { createHash } from 'node:crypto'

export const MODES = ['off', 'regex', 'dictionary']

const tag = (kind, value) => `[[${kind}_${createHash('sha256').update(value).digest('hex').slice(0, 8)}]]`

export function luhnOk(digits) {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (alt) { n *= 2; if (n > 9) n -= 9 }
    sum += n
    alt = !alt
  }
  return digits.length >= 13 && digits.length <= 19 && sum % 10 === 0
}

const PATTERNS = [
  ['EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['SSN', /\b\d{3}-\d{2}-\d{4}\b/g],
  ['KEY', /\b(?:sk|pk|api|key|tok)[-_][A-Za-z0-9]{16,}\b/g],
  ['PHONE', /(?<![\d-])(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]?\d{4}(?![\d-])/g],
]
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g

/** Build a list of exact strings (names, addresses) from the store for dictionary mode. */
export function buildDictionary(store) {
  const terms = []
  for (const c of store?.customers ?? []) {
    terms.push(['NAME', c.full_name])
    // street part of the address, e.g. "104 Maple Ave"
    terms.push(['ADDR', c.address])
    const street = c.address.split(',')[0]
    if (street) terms.push(['ADDR', street])
    const [first, last] = c.full_name.split(' ')
    if (last && last.length > 3) terms.push(['NAME', last]) // surname alone, long enough to avoid common-word hits
    if (first && first.length > 3) terms.push(['NAME', first])
  }
  // longest first so a full name wins over its parts
  return terms.sort((a, b) => b[1].length - a[1].length)
}

/**
 * Mask personal data in free text.
 * @returns {{text: string, hits: Array<{kind: string, value: string}>}}
 */
export function redact(text, mode = 'regex', dictionary = []) {
  if (mode === 'off' || typeof text !== 'string' || !text) return { text, hits: [] }
  const hits = []
  let out = text
  // cards first, so their digits are not mistaken for phone numbers
  out = out.replace(CARD_RE, m => {
    const digits = m.replace(/[ -]/g, '')
    if (!luhnOk(digits)) return m
    hits.push({ kind: 'CARD', value: m })
    return tag('CARD', digits)
  })
  for (const [kind, re] of PATTERNS) {
    out = out.replace(re, m => { hits.push({ kind, value: m }); return tag(kind, m) })
  }
  if (mode === 'dictionary') {
    for (const [kind, term] of dictionary) {
      if (!term || !out.includes(term)) continue
      out = out.split(term).join(tag(kind, term))
      hits.push({ kind, value: term })
    }
  }
  return { text: out, hits }
}

/** Recursively mask every string inside a JSON value (used for tool results). */
export function redactJson(value, mode, dictionary) {
  if (typeof value === 'string') return redact(value, mode, dictionary).text
  if (Array.isArray(value)) return value.map(v => redactJson(v, mode, dictionary))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactJson(v, mode, dictionary)]))
  return value
}

/** Cheap leak detector for the grader: which raw PII from the store is still visible in this text? */
export function findLeaks(text, store) {
  const leaks = new Set()
  for (const c of store.customers) {
    if (text.includes(c.email)) leaks.add('email')
    if (text.includes(c.phone)) leaks.add('phone')
    if (text.includes(c.card_number) || text.includes(c.card_number.replace(/(\d{4})(?=\d)/g, '$1 '))) leaks.add('card')
    if (text.includes(c.full_name)) leaks.add('name')
    if (text.includes(c.address.split(',')[0])) leaks.add('address')
  }
  if (/\+1-555-010-0199/.test(text)) leaks.add('phone')
  return [...leaks].sort()
}
