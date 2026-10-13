// GET /api/insights/source-app-conversion and GET /api/insights/funnel (04 §GET /api/insights/
// {source-app-conversion|funnel}, 06 §/growth; R6). Mounted at /api by worker/index.ts, behind
// requireSession. Pre-aggregated JSON for the two /growth panels; every number carries an
// `explain` question for the "Explain this" link (09 D-39). The parked panels (going-cold,
// data-quality) have no route, so they answer 404 like any unknown path.

import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { funnel } from '../insights/funnel'
import { sourceAppConversion } from '../insights/source-app'

export const insightRoutes = new Hono<AppEnv>()

insightRoutes.get('/insights/source-app-conversion', async (c) => c.json(await sourceAppConversion(c.env.DB)))

insightRoutes.get('/insights/funnel', async (c) => c.json(await funnel(c.env.DB)))
