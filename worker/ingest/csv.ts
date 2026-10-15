/**
 * Minimal RFC 4180 CSV parser for the three seed files (used by
 * scripts/csv2sql). Pure: text in, records out; no file I/O.
 *
 * Supports quoted fields, `""` escapes inside quotes, and CRLF or LF record ends. A final
 * line ending does not start an extra record. Anything it cannot read unambiguously throws
 * with the 1-based file line number (fail loud): a record whose field count differs from
 * the header's, a quote inside an unquoted field, text after a closing quote, or a quote
 * that is never closed.
 */

export interface ParsedCsv {
  /** The first record, as written. */
  header: string[]
  /** Every record after the header, each with exactly `header.length` fields. */
  rows: string[][]
  /** `lineNos[i]` is the 1-based file line on which `rows[i]` starts (the header is line 1). */
  lineNos: number[]
}

export function parseCsv(text: string): ParsedCsv {
  const records: string[][] = []
  const starts: number[] = []

  let line = 1
  let recordStart = 1
  let record: string[] = []
  let field = ''
  let inQuotes = false
  let quotedField = false
  let quoteOpenedOn = 0
  let i = 0

  const endField = () => {
    record.push(field)
    field = ''
    quotedField = false
  }
  const endRecord = () => {
    endField()
    records.push(record)
    starts.push(recordStart)
    record = []
  }

  while (i < text.length) {
    const ch = text[i]

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      if (ch === '\n') line += 1
      field += ch
      i += 1
      continue
    }

    if (ch === '"') {
      if (field !== '' || quotedField) {
        throw new Error(`CSV line ${line}: unexpected quote inside a field`)
      }
      inQuotes = true
      quotedField = true
      quoteOpenedOn = line
      i += 1
      continue
    }
    if (ch === ',') {
      endField()
      i += 1
      continue
    }
    if (ch === '\r' || ch === '\n') {
      endRecord()
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      line += 1
      recordStart = line
      continue
    }
    if (quotedField) {
      throw new Error(`CSV line ${line}: text after a closing quote`)
    }
    field += ch
    i += 1
  }

  if (inQuotes) {
    throw new Error(`CSV line ${quoteOpenedOn}: quoted field is never closed`)
  }
  // Text after the last line ending is a final record; a trailing line ending is not.
  if (field !== '' || quotedField || record.length > 0) endRecord()

  if (records.length === 0) throw new Error('CSV is empty: no header row')

  const header = records[0]
  const rows = records.slice(1)
  const lineNos = starts.slice(1)
  rows.forEach((row, idx) => {
    if (row.length !== header.length) {
      throw new Error(`CSV line ${lineNos[idx]}: ${row.length} fields, header has ${header.length}`)
    }
  })
  return { header, rows, lineNos }
}
