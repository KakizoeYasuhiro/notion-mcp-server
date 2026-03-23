import { describe, it, expect } from 'vitest'
import { structuredTruncate, findDedicatedToolHint, isValidPath, buildExecutionMetadata } from '../shared'

describe('structuredTruncate', () => {
  it('returns data unchanged when under size limit', () => {
    const data = { results: [{ id: '1' }, { id: '2' }] }
    const result = structuredTruncate(data, 10000)
    expect(result.truncated).toBe(false)
    expect(result.data).toEqual(data)
  })

  it('truncates results array structurally', () => {
    const bigResults = Array.from({ length: 100 }, (_, i) => ({
      id: `item-${i}`,
      title: 'x'.repeat(500),
    }))
    const data = { results: bigResults, has_more: false }
    const result = structuredTruncate(data, 5000)

    expect(result.truncated).toBe(true)
    expect(result.omitted_count).toBeGreaterThan(0)
    expect(result.total).toBe(100)

    // Result must be valid JSON
    const parsed = result.data as any
    expect(Array.isArray(parsed.results)).toBe(true)
    expect(parsed.results.length).toBeLessThan(100)

    // Verify it's actually under the size limit
    expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(5200) // with buffer
  })

  it('preserves metadata alongside truncated results', () => {
    const bigResults = Array.from({ length: 50 }, (_, i) => ({
      id: `item-${i}`,
      content: 'x'.repeat(1000),
    }))
    const data = { results: bigResults, has_more: true, next_cursor: 'abc' }
    const result = structuredTruncate(data, 5000)

    const parsed = result.data as any
    expect(parsed.has_more).toBe(true)
    expect(parsed.next_cursor).toBe('abc')
  })

  it('handles non-array large objects', () => {
    const data = { markdown: 'x'.repeat(100000), id: 'page-1' }
    const result = structuredTruncate(data, 5000)

    expect(result.truncated).toBe(true)
    // Should be valid JSON
    const str = JSON.stringify(result.data)
    expect(() => JSON.parse(str)).not.toThrow()
  })

  it('returns fallback for extremely large non-structured data', () => {
    const data = 'x'.repeat(200000)
    const result = structuredTruncate(data, 1000)

    expect(result.truncated).toBe(true)
    const parsed = result.data as any
    expect(parsed.message).toContain('too large')
  })
})

describe('findDedicatedToolHint', () => {
  it('returns hint for /v1/search', () => {
    const hint = findDedicatedToolHint('/v1/search')
    expect(hint).toContain('search')
  })

  it('returns hint for /v1/pages/{id}', () => {
    const hint = findDedicatedToolHint('/v1/pages/abc123')
    expect(hint).toContain('page')
  })

  it('returns hint for /v1/blocks/{id}/children', () => {
    const hint = findDedicatedToolHint('/v1/blocks/abc/children')
    expect(hint).toContain('block')
  })

  it('returns null for unknown paths', () => {
    const hint = findDedicatedToolHint('/v1/file_uploads')
    expect(hint).toBeNull()
  })

  it('returns hint for /v1/data_sources/{id}/query', () => {
    const hint = findDedicatedToolHint('/v1/data_sources/xyz/query')
    expect(hint).toContain('query')
  })
})

describe('isValidPath', () => {
  it('accepts valid paths', () => {
    expect(isValidPath('/v1/pages/abc')).toBe(true)
    expect(isValidPath('/v1/search')).toBe(true)
  })

  it('rejects invalid paths', () => {
    expect(isValidPath('')).toBe(false)
    expect(isValidPath('/v2/pages')).toBe(false)
    expect(isValidPath('/v1/../secret')).toBe(false)
    expect(isValidPath('//evil.com/v1/')).toBe(false)
  })
})

describe('buildExecutionMetadata', () => {
  it('returns null when no retries', () => {
    expect(buildExecutionMetadata(0, 0)).toBeNull()
  })

  it('returns metadata when retries occurred', () => {
    const meta = buildExecutionMetadata(2, 4500)
    expect(meta).not.toBeNull()
    expect(meta!.retries).toBe(2)
    expect(meta!.total_wait_ms).toBe(4500)
    expect(meta!.hint).toContain('Rate limit')
  })
})
