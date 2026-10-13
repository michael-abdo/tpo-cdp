// Why a step on /audit was blocked, in words (06 §/audit, §UI principles 4). The worker stores a
// blocked step's error as "<code>: <detail>" (worker/assistant writers); the page shows the sentence
// for the code it starts with, and the raw error stays in Technical details. Pure, so the test runs
// it on the errors the worker writes (test/audit.test.ts).

/** The sentence for a blocked step whose error starts with no known code. */
export const BLOCKED_FALLBACK = 'This step was blocked.'

/** Why a step was blocked, in words, from the stored error's code (worker/assistant writers; gate2_/gate3_denied: tool-executor.ts deny). */
export const BLOCK_REASON: Array<[string, string]> = [
  ['gate1', 'The question was refused by the input check before anything was sent to the AI.'],
  ['blocked_pii', 'Personal data was found, so the request was stopped and nothing more was sent.'],
  [
    'sql_in_output',
    "The AI's wording held database code, so it was replaced with a plain sentence from the server.",
  ],
  ['rate_limited', 'Too many questions were asked this hour.'],
  ['assistant_unavailable', 'The AI key is not set up on this server.'],
  ['no_tools', 'The assistant has no data tools turned on.'],
  ['tool_config_error', 'A data tool is set up wrongly.'],
  ['unknown_tool', 'The AI asked for a data tool that does not exist.'],
  [
    'gate2_denied',
    'The AI asked a data tool for something it may not read, or in a form the tool does not accept, so the call was refused and the AI was told why.',
  ],
  [
    'gate3_denied',
    "The AI's database query was not one plain read-only question, so it was refused before it ran and the AI was told why.",
  ],
]

export function blockReason(error: string | null): string {
  const found = BLOCK_REASON.find(([code]) => error?.startsWith(code))
  return found?.[1] ?? BLOCKED_FALLBACK
}
