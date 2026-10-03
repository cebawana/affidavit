// The message parts every backend accepts, and the JSON every caller expects
// back. A backend turns these into its own wire format.

export const image = png => ({ type: 'image', png })
export const text = t => ({ type: 'text', text: t })

/** The first JSON object in a model reply, tolerating a ```json fence. */
export function parseJson(reply) {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`reply had no JSON object: ${reply.slice(0, 200)}`)
  return JSON.parse(reply.slice(start, end + 1))
}
