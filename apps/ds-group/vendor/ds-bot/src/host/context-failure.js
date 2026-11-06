// DSCord addition, 2026-11-06. Some OpenAI-compatible providers report a
// context overflow as INVALID_REQUEST. Only a positively identified window
// overflow may move the conversation; ordinary 400s must keep their error.
export function isContextOverflow(failure) {
  if (failure?.code === 'CONTEXT_WINDOW_EXCEEDED') return true
  if (failure?.code !== 'INVALID_REQUEST') return false
  const match = /Input too long:\s*model limit\s+([\d,]+)\s+tokens,\s*requested\s+([\d,]+)\s+tokens/i.exec(String(failure.message ?? ''))
  if (match === null) return false
  const [limit, requested] = match.slice(1).map(value => Number(value.replaceAll(',', '')))
  return Number.isSafeInteger(limit) && limit > 0 && Number.isSafeInteger(requested) && requested > limit
}
