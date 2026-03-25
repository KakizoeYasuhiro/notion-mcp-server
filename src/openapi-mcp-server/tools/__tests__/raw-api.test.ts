import axios from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleRawApiCall, rawApiToolDefinition, validatePath } from '../raw-api'

vi.mock('axios', () => ({
  default: vi.fn(),
}))

const mockedAxios = vi.mocked(axios)

function identity<T>(x: T): T {
  return x as T
}

describe('validatePath', () => {
  it('accepts valid paths', () => {
    expect(validatePath('/v1/pages/abc123')).toBe('/v1/pages/abc123')
    expect(validatePath('/v1/databases/xyz/query')).toBe('/v1/databases/xyz/query')
    expect(validatePath('/v1/blocks/abc-def/children')).toBe('/v1/blocks/abc-def/children')
    expect(validatePath('/v1/users/me')).toBe('/v1/users/me')
    expect(validatePath('/v1/search')).toBe('/v1/search')
    expect(validatePath('/v1/pages/abc_123/markdown')).toBe('/v1/pages/abc_123/markdown')
  })

  it('rejects empty or non-string paths', () => {
    expect(validatePath('')).toBeNull()
    expect(validatePath(null as any)).toBeNull()
    expect(validatePath(undefined as any)).toBeNull()
  })

  it('rejects paths not starting with /v1/', () => {
    expect(validatePath('/v2/pages/abc')).toBeNull()
    expect(validatePath('/pages/abc')).toBeNull()
    expect(validatePath('v1/pages/abc')).toBeNull()
    expect(validatePath('/api/v1/pages/abc')).toBeNull()
  })

  it('rejects paths with embedded query strings', () => {
    expect(validatePath('/v1/pages/abc?foo=bar')).toBeNull()
    expect(validatePath('/v1/pages/abc#fragment')).toBeNull()
  })

  it('rejects path traversal attempts', () => {
    expect(validatePath('/v1/../etc/passwd')).toBeNull()
    expect(validatePath('/v1/pages/../../secret')).toBeNull()
    expect(validatePath('/v1/pages/abc/..%2f..%2f')).toBeNull()
  })

  it('rejects double slashes (protocol-relative URL attack)', () => {
    expect(validatePath('//attacker.com/v1/pages')).toBeNull()
    expect(validatePath('/v1//pages/abc')).toBeNull()
  })

  it('rejects URL-encoded dots', () => {
    expect(validatePath('/v1/%2e%2e/secret')).toBeNull()
    expect(validatePath('/v1/%2E%2E/secret')).toBeNull()
  })

  it('rejects paths with special characters', () => {
    expect(validatePath('/v1/pages/abc;rm -rf')).toBeNull()
    expect(validatePath('/v1/pages/<script>')).toBeNull()
    expect(validatePath('/v1/pages/abc def')).toBeNull()
  })
})

describe('rawApiToolDefinition', () => {
  it('has the correct name', () => {
    expect(rawApiToolDefinition.name).toBe('notion-raw-api')
  })

  it('has required fields in inputSchema', () => {
    const schema = rawApiToolDefinition.inputSchema as any
    expect(schema.required).toContain('method')
    expect(schema.required).toContain('path')
  })

  it('has destructiveHint annotation', () => {
    expect(rawApiToolDefinition.annotations?.destructiveHint).toBe(true)
  })

  it('has method enum with allowed values', () => {
    const schema = rawApiToolDefinition.inputSchema as any
    expect(schema.properties.method.enum).toEqual(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])
  })
})

describe('handleRawApiCall', () => {
  const baseUrl = 'https://api.notion.com'
  const authHeaders = {
    Authorization: 'Bearer test-token',
    'Notion-Version': '2026-03-11',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    // Suppress console.error in tests
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects invalid paths', async () => {
    const result = await handleRawApiCall({ method: 'GET', path: '/v2/bad' }, baseUrl, authHeaders, identity as any)
    const content = JSON.parse(result.content[0].text)
    expect(content.status).toBe('error')
    expect(content.message).toContain('Invalid path')
  })

  it('rejects path traversal', async () => {
    const result = await handleRawApiCall(
      { method: 'GET', path: '/v1/../secret' },
      baseUrl,
      authHeaders,
      identity as any,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.status).toBe('error')
  })

  it('rejects double-slash SSRF attempts', async () => {
    const result = await handleRawApiCall(
      { method: 'GET', path: '//evil.com/v1/pages' },
      baseUrl,
      authHeaders,
      identity as any,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.status).toBe('error')
  })

  it('rejects non-notion.com base URLs', async () => {
    const result = await handleRawApiCall(
      { method: 'GET', path: '/v1/pages/abc' },
      'https://evil.com',
      authHeaders,
      identity as any,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.status).toBe('error')
    expect(content.message).toContain('notion.com')
  })

  it('makes successful GET request', async () => {
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: { object: 'page', id: 'abc123' },
      headers: {},
    } as any)

    const result = await handleRawApiCall(
      { method: 'GET', path: '/v1/pages/abc123' },
      baseUrl,
      authHeaders,
      identity as any,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.status).toBe(200)
    expect(content.data.object).toBe('page')

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://api.notion.com/v1/pages/abc123',
        timeout: 30000,
      }),
    )
  })

  it('includes Notion-Version header', async () => {
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: {},
      headers: {},
    } as any)

    await handleRawApiCall({ method: 'GET', path: '/v1/pages/abc' }, baseUrl, authHeaders, identity as any)

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          'Notion-Version': '2026-03-11',
        }),
      }),
    )
  })

  it('sends body only for POST/PATCH/PUT', async () => {
    mockedAxios.mockResolvedValue({
      status: 200,
      data: {},
      headers: {},
    } as any)

    // GET should NOT send body
    await handleRawApiCall(
      { method: 'GET', path: '/v1/pages/abc', body: { foo: 'bar' } },
      baseUrl,
      authHeaders,
      identity as any,
    )
    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ data: undefined }))

    vi.clearAllMocks()

    // POST should send body
    await handleRawApiCall(
      { method: 'POST', path: '/v1/pages', body: { title: 'test' } },
      baseUrl,
      authHeaders,
      identity as any,
    )
    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ data: { title: 'test' } }))
  })

  it('truncates large responses', async () => {
    const largeData = 'x'.repeat(100000)
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: largeData,
      headers: {},
    } as any)

    const result = await handleRawApiCall(
      { method: 'GET', path: '/v1/pages/abc' },
      baseUrl,
      authHeaders,
      identity as any,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.truncated).toBe(true)
  })

  it('retries on 429 rate limit', async () => {
    mockedAxios
      .mockResolvedValueOnce({
        status: 429,
        data: { message: 'rate limited' },
        headers: { 'retry-after': '1' },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true },
        headers: {},
      } as any)

    const result = await handleRawApiCall(
      { method: 'GET', path: '/v1/pages/abc' },
      baseUrl,
      authHeaders,
      identity as any,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.status).toBe(200)
    expect(mockedAxios).toHaveBeenCalledTimes(2)
  })

  it('handles network errors without leaking details', async () => {
    mockedAxios.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:443'))

    const result = await handleRawApiCall(
      { method: 'GET', path: '/v1/pages/abc' },
      baseUrl,
      authHeaders,
      identity as any,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.status).toBe('error')
    expect(content.message).toBe('Request failed')
  })

  it('handles timeout errors', async () => {
    mockedAxios.mockRejectedValueOnce(new Error('timeout of 30000ms exceeded'))

    const result = await handleRawApiCall(
      { method: 'GET', path: '/v1/pages/abc' },
      baseUrl,
      authHeaders,
      identity as any,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.status).toBe('error')
    expect(content.message).toBe('Request timed out (30s)')
  })

  it('normalizes baseUrl trailing slash', async () => {
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: {},
      headers: {},
    } as any)

    await handleRawApiCall(
      { method: 'GET', path: '/v1/pages/abc' },
      'https://api.notion.com/',
      authHeaders,
      identity as any,
    )

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.notion.com/v1/pages/abc',
      }),
    )
  })

  it('defaults method to GET when not provided', async () => {
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: {},
      headers: {},
    } as any)

    await handleRawApiCall({ path: '/v1/pages/abc' } as any, baseUrl, authHeaders, identity as any)

    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ method: 'get' }))
  })

  it('adds fallback Notion-Version when not in authHeaders', async () => {
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: {},
      headers: {},
    } as any)

    await handleRawApiCall(
      { method: 'GET', path: '/v1/pages/abc' },
      baseUrl,
      { Authorization: 'Bearer token-only' },
      identity as any,
    )

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          'Notion-Version': '2026-03-11',
        }),
      }),
    )
  })

  it('logs audit info to stderr', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: {},
      headers: {},
    } as any)

    await handleRawApiCall(
      { method: 'POST', path: '/v1/search', body: { query: 'test' } },
      baseUrl,
      authHeaders,
      identity as any,
    )

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[raw-api] POST /v1/search'))
  })
})
