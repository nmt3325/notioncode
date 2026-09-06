export type Redactor = ((text: string) => string) & { stream?: (snapshot: string, final: boolean) => string }

/** Redact credentials both as plain text and their common serialized forms. */
export function secretRedactor(secrets: () => string[]): Redactor {
  const variants = () => [...new Set(secrets().filter(Boolean).flatMap(secret => [secret,
    JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]))].sort((a, b) => b.length - a.length)
  const redact = (text: string) => {
    for (const secret of variants()) text = text.split(secret).join("[redacted]")
    return text
  }
  return Object.assign(redact, { stream: (snapshot: string, final: boolean) => {
    // A credential may straddle any two upstream events. Hold only the undecidable
    // suffix, rather than emitting a prefix that cannot subsequently be retracted.
    let hold = 0
    if (!final) for (const secret of variants()) for (let n = Math.min(secret.length - 1, snapshot.length); n > hold; n--) {
      if (snapshot.endsWith(secret.slice(0, n))) { hold = n; break }
    }
    return redact(hold ? snapshot.slice(0, -hold) : snapshot)
  } })
}

const PRIVATE_KEY = /(?:token|secret|password|passwd|authorization|cookie|api[_-]?key|private[_-]?key|credential)/i
const HIDDEN_KEY = /^(?:thinking|reasoning|reasoning_content|chain_of_thought)$/i
/** Bounded display data, not a mutation of actual tool arguments or results. */
export function displayValue(value: unknown, redact: (text: string) => string, depth = 0): unknown {
  if (depth > 6) return "[display depth limit]"
  if (typeof value === "string") {
    const safe = redact(value).replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|$))/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    return safe.length > 16000 ? safe.slice(0, 16000) + "\n[display truncated]" : safe
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value
  if (Array.isArray(value)) return value.slice(0, 50).map(x => displayValue(x, redact, depth + 1))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [
    redact(key), PRIVATE_KEY.test(key) || HIDDEN_KEY.test(key) ? "[redacted]" : displayValue(item, redact, depth + 1),
  ]))
  return null
}
export function displayText(value: unknown, redact: (text: string) => string): string {
  const safe = displayValue(value, redact)
  const text = typeof safe === "string" ? safe : JSON.stringify(safe, null, 2)
  return text.length > 24000 ? text.slice(0, 24000) + "\n[display truncated]" : text
}
