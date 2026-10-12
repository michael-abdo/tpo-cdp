import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { EMAIL_REGEX, PII_COLUMNS, RAW_ID_REGEX } from '../shared/pii'
import { pkeyForEmail, pkeyForUnknownUser, visitorHash } from '../shared/pseudonym'

// 05 §Pseudonymous key, 01 §PII denylist, 09 D-17. Inputs are real rows from data/*.csv
// (the 02 demo subjects and the second app user). The secret comes from .dev.vars and is
// never printed: assertions compare keys, not the secret.

const KEY_FORMAT = /^pk_[0-9a-f]{16}$/
const JOY = 'joy.hall830@protonmail.com'
const JULIA = 'julia.evans230@gmail.com'
const JOY_USER = 'u_ceed5f12'
const JOY_VISITOR = 'v_c9e136fd6d'

function secret(): string {
  const value = env.PII_KEY_SECRET
  if (!value) throw new Error('PII_KEY_SECRET missing from .dev.vars; the test cannot run')
  return value
}

describe('pseudonymous keys (05 §Pseudonymous key)', () => {
  it('every key has the pk_ + 16 hex format', async () => {
    expect(await pkeyForEmail(secret(), JOY)).toMatch(KEY_FORMAT)
    expect(await pkeyForUnknownUser(secret(), JOY_USER)).toMatch(KEY_FORMAT)
    expect(await visitorHash(secret(), JOY_VISITOR)).toMatch(KEY_FORMAT)
  })

  it('is deterministic', async () => {
    expect(await pkeyForEmail(secret(), JOY)).toBe(await pkeyForEmail(secret(), JOY))
    expect(await pkeyForUnknownUser(secret(), JOY_USER)).toBe(await pkeyForUnknownUser(secret(), JOY_USER))
    expect(await visitorHash(secret(), JOY_VISITOR)).toBe(await visitorHash(secret(), JOY_VISITOR))
  })

  it('different inputs give different keys', async () => {
    expect(await pkeyForEmail(secret(), JOY)).not.toBe(await pkeyForEmail(secret(), JULIA))
    expect(await pkeyForUnknownUser(secret(), JOY_USER)).not.toBe(
      await pkeyForUnknownUser(secret(), 'u_2b6447a3'),
    )
  })

  it('a different secret gives a different key', async () => {
    const other = `${secret()}:rotated`
    expect(await pkeyForEmail(secret(), JOY)).not.toBe(await pkeyForEmail(other, JOY))
  })

  it('the email, user: and visitor: derivations differ for the same string', async () => {
    // A normalized email is valid input to all three, so the only difference is the prefix.
    const keys = new Set([
      await pkeyForEmail(secret(), JOY),
      await pkeyForUnknownUser(secret(), JOY),
      await visitorHash(secret(), JOY),
    ])
    expect(keys.size).toBe(3)
  })

  it('an empty secret throws (fail fast)', async () => {
    await expect(pkeyForEmail('', JOY)).rejects.toThrow(/PII_KEY_SECRET is empty/)
    await expect(pkeyForUnknownUser('', JOY_USER)).rejects.toThrow(/PII_KEY_SECRET is empty/)
    await expect(visitorHash('', JOY_VISITOR)).rejects.toThrow(/PII_KEY_SECRET is empty/)
  })

  it('a raw spelling is refused rather than keyed twice, and the error does not echo it', async () => {
    const raw = ' Joy.Hall830@ProtonMail.com '
    const attempt = pkeyForEmail(secret(), raw)
    await expect(attempt).rejects.toThrow(/already normalized/)
    await expect(attempt).rejects.not.toThrow(/joy/i)
  })
})

describe('PII denylist and patterns (01 §PII denylist, 05 §Scanner)', () => {
  it('lists exactly the denylisted columns', () => {
    expect(PII_COLUMNS).toEqual([
      'email_norm',
      'email_raw',
      'user_id',
      'device_id',
      'visitor_id',
      'raw_row',
      'properties',
    ])
  })

  it('EMAIL_REGEX finds an email inside serialized JSON, case-insensitively', () => {
    expect(EMAIL_REGEX.test(JSON.stringify({ who: 'Joy.Hall830@ProtonMail.com' }))).toBe(true)
    expect(EMAIL_REGEX.test(JSON.stringify({ page: '/news/church-attendance-study' }))).toBe(false)
  })

  it('RAW_ID_REGEX finds real user, device and visitor ids but not a pk_ key', async () => {
    for (const id of [JOY_USER, 'd_4b21e8', JOY_VISITOR]) {
      expect(RAW_ID_REGEX.test(JSON.stringify({ id }))).toBe(true)
    }
    const pkey = await pkeyForEmail(secret(), JOY)
    expect(RAW_ID_REGEX.test(JSON.stringify({ pkey }))).toBe(false)
  })
})
