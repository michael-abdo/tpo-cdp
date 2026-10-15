// /api/insights: the board and the four panel routes.
// Mounted at /api by worker/index.ts, behind requireJson and requireSession, so every
// route here needs a session; none is an assistant tool.
//   - the board: GET /api/insights re-runs every tile with no model call; POST pins an answer
//     from its audit trace; PATCH edits a tile; DELETE removes one (worker/insights/board.ts)
//   - the four panel routes stay: pre-aggregated JSON for the former /growth panels, the
//     same functions the board's insight_panel tool calls; every number the assistant can
//     reproduce carries an `explain` question.
//   - there is no approval queue: a free-form query_sql pin that fails the pin grammar is
//     refused outright (worker/insights/board.ts), so there are no /insights/approvals/* routes
//     (404 like any unknown route).

import { Hono } from 'hono'
import { ApiError } from '../auth/middleware'
import type { AppEnv } from '../env'
import { deleteInsight, listBoard, patchInsight, pinFromTrace } from '../insights/board'
import { dataQuality } from '../insights/data-quality'
import { funnel } from '../insights/funnel'
import { goingCold } from '../insights/going-cold'
import { sourceAppConversion } from '../insights/source-app'

export const insightRoutes = new Hono<AppEnv>()

/** The JSON body; one that does not parse is 400 invalid_body, naming only the error's class (a SyntaxError message quotes the body). */
async function jsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch (err) {
    const detail = `body is not JSON: ${err instanceof Error ? err.name : 'unknown'}`
    console.warn(JSON.stringify({ at: 'insights-board', outcome: 'invalid_body', details: [detail] }))
    throw new ApiError(400, 'invalid_body', 'The request body is not valid for this endpoint.', [detail])
  }
}

insightRoutes.get('/insights', async (c) => c.json(await listBoard(c.env.DB)))

insightRoutes.post('/insights', async (c) => c.json(await pinFromTrace(c.env.DB, await jsonBody(c.req.raw)), 201))

insightRoutes.get('/insights/source-app-conversion', async (c) => c.json(await sourceAppConversion(c.env.DB)))

insightRoutes.get('/insights/funnel', async (c) => c.json(await funnel(c.env.DB)))

insightRoutes.get('/insights/going-cold', async (c) => c.json(await goingCold(c.env.DB)))

insightRoutes.get('/insights/data-quality', async (c) => c.json(await dataQuality(c.env.DB)))

insightRoutes.patch('/insights/:id', async (c) => c.json(await patchInsight(c.env.DB, c.req.param('id'), await jsonBody(c.req.raw))))

insightRoutes.delete('/insights/:id', async (c) => {
  await deleteInsight(c.env.DB, c.req.param('id'))
  return c.body(null, 204)
})
