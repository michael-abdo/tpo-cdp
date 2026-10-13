// GET /api/insights/{source-app-conversion|funnel|going-cold|data-quality} (04 §GET /api/insights/
// …, 06 §/growth; R6; going-cold and data-quality are parked items 4 and 5 of 16 §If time
// remains). Mounted at /api by worker/index.ts, behind requireSession. Pre-aggregated JSON for
// the four /growth panels; every number the assistant can reproduce carries an `explain`
// question for the "Explain this" link (09 D-39).

import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { dataQuality } from '../insights/data-quality'
import { funnel } from '../insights/funnel'
import { goingCold } from '../insights/going-cold'
import { sourceAppConversion } from '../insights/source-app'

export const insightRoutes = new Hono<AppEnv>()

insightRoutes.get('/insights/source-app-conversion', async (c) => c.json(await sourceAppConversion(c.env.DB)))

insightRoutes.get('/insights/funnel', async (c) => c.json(await funnel(c.env.DB)))

insightRoutes.get('/insights/going-cold', async (c) => c.json(await goingCold(c.env.DB)))

insightRoutes.get('/insights/data-quality', async (c) => c.json(await dataQuality(c.env.DB)))
