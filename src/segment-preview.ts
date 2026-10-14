// One preview on /segments and what it leaves in Previous searches (19-segments-spec §2, 09 D-69).
// A search is remembered only after the server answered 200, and what is remembered is the
// canonical `filters` the server echoed, never the object the browser sent: the echo is what the
// count on screen was computed from, and its canonical key is what keeps a row from showing twice.
// A rejected preview remembers nothing and keeps the 400's field-level problems for the page
// (src/segment-form.ts filterProblems). The transport and the store are passed in, so the same
// function runs on the page (postJson, localStorage) and in the worker tests against the real
// server (test/segments.test.ts T-SEG-4). No DOM here.

import { ApiError } from './api-error'
import { recordSearch, type SearchStore } from './previous-searches'
import { type FilterProblem, filterProblems } from './segment-form'
import type { SegmentFilters, SegmentPreview } from './types'

/** The shown result: an ok one keeps the echoed filters, so its notes and the export never describe an edited form. */
export type PreviewResult =
  | { status: 'ok'; data: SegmentPreview; filters: SegmentFilters }
  | { status: 'error'; message: string; problems: FilterProblem[] }

/** The body POST /api/segments/preview takes (04). */
export interface PreviewRequest {
  filters: SegmentFilters
  limit: number
}

/**
 * Runs one preview through `post` and records it in `store` only on a 200, using the echo.
 * `stored` is the Previous searches list after recording, or null when nothing was recorded.
 */
export async function previewAndRecord(
  request: PreviewRequest,
  post: (body: PreviewRequest) => Promise<SegmentPreview>,
  store: SearchStore | null,
): Promise<{ result: PreviewResult; stored: SegmentFilters[] | null }> {
  let data: SegmentPreview
  try {
    data = await post(request)
  } catch (err) {
    const invalidFilters = err instanceof ApiError && err.code === 'invalid_filters'
    return {
      result: {
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
        problems: invalidFilters ? filterProblems(err.details) : [],
      },
      stored: null,
    }
  }
  return { result: { status: 'ok', data, filters: data.filters }, stored: recordSearch(data.filters, store) }
}
