# Facilitator runbook (live demo, about 12 minutes)

Use this while attendees follow along. Everything runs offline with the mock model.

## Before the session
- `npm install && node lab.mjs setup && npm test` on the presenter laptop, and once on a Windows or WSL2 machine if you can.
- Send attendees the quickstart 48 hours ahead and ask for a screenshot of `node lab.mjs check` all PASS.
- Keep `node lab.mjs reset` handy: it fixes most "odd results" instantly.
- Optional: `npm install --no-save @earendil-works/pi-coding-agent` for the E9 demo.

## Live sequence (say the prediction question first, every time)

| Min | Command | Ask the room | Point out |
|---|---|---|---|
| 0 | `node lab.mjs playground` | "Which PII mode hides a customer name?" Flip off, regex, dictionary. | Regex leaves the name and street. Dictionary masks them. Same code the plugins run. |
| 3 | `node lab.mjs run "Please refund ORD-10001, the bottle arrived dented."` | "What will the model see from get_customer?" | Raw email, phone, address, card. The answer repeats the email. |
| 5 | same command, add `--pii regex`, then `--pii dictionary` | "Is the name masked now?" | Placeholders. Then the name goes too. Show `patches/pii-regex.yml`: it is the whole difference. |
| 7 | `node lab.mjs run "Please refund ORD-10005, the sunglasses are scratched." --policy off` | "Will it refund a final-sale item?" | It does: the model obeyed a note. Show the note in the playground. |
| 8 | same, `--policy lenient` | "What happens now?" | Policy denies, model opens a ticket. Show `plugins/shop-policy/index.js` (about 20 lines). |
| 10 | `node lab.mjs run "Please refund ORD-10006, the headphones stopped working." --policy strict` | "Who answers the approval?" | Nobody in headless, so it fails closed. A browser would prompt (not verified here). |
| 11 | `node lab.mjs eval --pii dictionary --policy strict` | "How many tasks leak PII?" | 10 of 10 pass, 0 leak. Then `--pii off` to show 7 of 10 leak. |
| 12 | (optional) `node lab.mjs pi "Please refund ORD-10005, the sunglasses are scratched." --pii dictionary --policy lenient` | "Same outcome in a different harness?" | Yes. Pi calls the seams `context`, `tool_call`, `tool_result`. |

## Honest caveats to say out loud
- The model here is a script, not an LLM. It is gullible on purpose. Real models vary, so run E6 with a real route.
- dsh is a developer preview (pinned to 0.2.1-rc.2). Expect breaking changes.
- Regex and dictionary masking are partial. Use real controls and a governed gateway for real data.

## If something breaks
| Problem | Do this |
|---|---|
| Mock port busy | `MOCK_PORT=8788 node lab.mjs run ...` |
| No output from dsh | `LAB_DEBUG=1 node lab.mjs run ...` shows dsh stderr |
| Results look wrong | `node lab.mjs reset`, then rerun |
| Install fails for one person | Pair them with a neighbor and use the playground |
