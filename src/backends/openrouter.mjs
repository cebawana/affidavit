// One vision chat call through OpenRouter. Needs OPENROUTER_API_KEY (read from
// the config's envFiles or the environment).

export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5'
export const DEFAULT_CONCURRENCY = 4

export async function chat({ model, system, content, maxTokens = 4000 }) {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY is not set')

  const wire = content.map(part => part.type === 'image'
    ? { type: 'image_url', image_url: { url: `data:image/png;base64,${part.png.toString('base64')}` } }
    : { type: 'text', text: part.text })

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Affidavit' },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: maxTokens,
      usage: { include: true },
      messages: [{ role: 'system', content: system }, { role: 'user', content: wire }],
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${body?.error?.message ?? JSON.stringify(body).slice(0, 300)}`)
  return {
    text: body.choices?.[0]?.message?.content ?? '',
    model: body.model ?? model,
    costUsd: typeof body.usage?.cost === 'number' ? body.usage.cost : null,
    tokens: body.usage?.total_tokens ?? null,
  }
}
