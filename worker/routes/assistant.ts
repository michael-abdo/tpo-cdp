// POST /api/assistant. Mounted at /api behind requireJson and requireSession, so
// `c.get('session')` is the verified session. Single-shot: the body is exactly {question}; there
// is no multi-turn history, which would be the hardest path to keep PII off. The layers
// themselves are worker/assistant/route.ts.

import { Hono } from 'hono'
import { ApiError } from '../auth/middleware'
import { type AppEnv, requireSecret } from '../env'
import { clientKeyHash } from '../../shared/pseudonym'
import { anthropicTransport, type MessagesTransport } from '../assistant/loop'
import { answerQuestion } from '../assistant/route'

function invalidBody(details: string[]): ApiError {
  console.warn(JSON.stringify({ at: 'assistant', outcome: 'invalid_body', details }))
  return new ApiError(400, 'invalid_body', 'Send a JSON object with only "question", a string.', details)
}

async function readQuestion(req: Request): Promise<string> {
  let parseError: string | undefined
  const body: unknown = await req.json().catch((err: unknown) => {
    // The error's class name only: a JSON SyntaxError message quotes the body.
    parseError = err instanceof Error ? err.name : 'unknown'
    return undefined
  })
  if (parseError !== undefined) throw invalidBody([`body is not JSON: ${parseError}`])
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalidBody(['body is not a JSON object'])
  const unknown = Object.keys(body).filter((k) => k !== 'question')
  if (unknown.length > 0) throw invalidBody(unknown.map((k) => `unknown field: ${k}`))
  const question = (body as { question?: unknown }).question
  if (typeof question !== 'string' || question.trim() === '') throw invalidBody(['question must be a non-empty string'])
  return question
}

/**
 * The route, with the model transport factory as a parameter: worker/index.ts mounts
 * `assistantRoutes()` with the direct Anthropic transport; tests mount it with a transport
 * written in the test file.
 */
export function assistantRoutes(transportFor: (apiKey: string) => MessagesTransport = anthropicTransport): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  routes.post('/assistant', async (c) => {
    const question = await readQuestion(c.req.raw)
    // Cloudflare sets CF-Connecting-IP at the edge; local dev has no edge, so every local client shares one key.
    const clientIp = c.req.header('cf-connecting-ip') ?? 'local'
    const response = await answerQuestion(
      {
        db: c.env.DB,
        apiKey: c.env.ANTHROPIC_API_KEY,
        transportFor,
        sessionSub: c.get('session').sub,
        clientLimiter: c.env.ASSISTANT_LIMITER,
        clientIp,
        clientKey: await clientKeyHash(requireSecret(c.env, 'PII_KEY_SECRET'), clientIp),
      },
      question,
    )
    return c.json(response)
  })
  return routes
}
