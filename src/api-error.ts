// The failed-call half of the UI's HTTP client (04 §Error envelope), kept free of the DOM so the
// worker test project can turn a real server response into the same ApiError the page sees
// (test/segments.test.ts, T-SEG-4/7/9). src/api.ts is the client and re-exports ApiError.

/**
 * A failed API call: the HTTP status and the envelope's `error` code, `message` and `details`
 * (04 §Error envelope; `[]` when the body has none). /segments reads the details of a 400
 * `invalid_filters` to name the field and its limit (src/segment-form.ts filterProblems).
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: readonly unknown[]

  constructor(status: number, code: string, message: string, details: readonly unknown[] = []) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/** The envelope as an ApiError; a body that is not the envelope still fails loud with its status. */
export async function toApiError(res: Response): Promise<ApiError> {
  const text = await res.text()
  try {
    const body: unknown = JSON.parse(text)
    if (typeof body === 'object' && body !== null) {
      const { error, message, details } = body as Record<string, unknown>
      if (typeof error === 'string' && typeof message === 'string')
        return new ApiError(res.status, error, message, Array.isArray(details) ? details : [])
    }
  } catch (err) {
    console.error('api: error response is not JSON', res.status, err)
  }
  return new ApiError(
    res.status,
    'unexpected_response',
    `The server answered ${res.status} ${res.statusText} without an error message.`,
  )
}
