// Append-only JSONL audit trail: .runs/audit.jsonl records what the MODEL saw and what policy decided.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function audit(file, event) {
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n')
  } catch (err) {
    console.error('[audit] could not write', err.message)
  }
}
