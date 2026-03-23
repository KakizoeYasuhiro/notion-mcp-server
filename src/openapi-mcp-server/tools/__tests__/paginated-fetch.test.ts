import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handlePaginatedFetch, paginatedFetchToolDefinition } from '../paginated-fetch'
import axios from 'axios'

vi.mock('axios', () => ({
  default: vi.fn(),
}))

const mockedAxios = vi.mocked(axios)
const identity = (x: Record<string, unknown>) => x

const baseUrl = 'https://api.notion.com'
const authHeaders = { 'Authorization': 'Bearer test', 'Notion-Version': '2026-03-11' }

describe('paginatedFetchToolDefinition', () => {
  it('has correct name and required fields', () => {
    expect(paginatedFetchToolDefinition.name).toBe('notion-paginated-fetch')
    const schema = paginatedFetchToolDefinition.inputSchema as any
    expect(schema.required).toContain('method')
    expect(schema.required).toContain('path')
  })

  it('has readOnlyHint annotation', () => {
    expect(paginatedFetchToolDefinition.annotations?.readOnlyHint).toBe(true)
  })
})

describe('handlePaginatedFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects invalid paths', async () => {
    const result = await handlePaginatedFetch(
      { method: 'GET', path: '/v2/bad' },
      baseUrl, authHeaders, identity,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.status).toBe('error')
  })

  it('rejects non-GET/POST methods', async () => {
    const result = await handlePaginatedFetch(
      { method: 'DELETE', path: '/v1/pages/abc' },
      baseUrl, authHeaders, identity,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.status).toBe('error')
    expect(content.message).toContain('GET and POST')
  })

  it('fetches single page of results', async () => {
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: {
        results: [{ id: '1' }, { id: '2' }],
        has_more: false,
        next_cursor: null,
      },
      headers: {},
    } as any)

    const result = await handlePaginatedFetch(
      { method: 'POST', path: '/v1/search', body: { query: 'test' } },
      baseUrl, authHeaders, identity,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.status).toBe(200)
    expect(content.total_fetched).toBe(2)
    expect(content.results).toHaveLength(2)
  })

  it('auto-paginates through multiple pages', async () => {
    mockedAxios
      .mockResolvedValueOnce({
        status: 200,
        data: {
          results: [{ id: '1' }],
          has_more: true,
          next_cursor: 'cursor-abc',
        },
        headers: {},
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          results: [{ id: '2' }],
          has_more: false,
          next_cursor: null,
        },
        headers: {},
      } as any)

    const result = await handlePaginatedFetch(
      { method: 'POST', path: '/v1/search' },
      baseUrl, authHeaders, identity,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.total_fetched).toBe(2)
    expect(content.pages_fetched).toBe(2)
    expect(mockedAxios).toHaveBeenCalledTimes(2)

    // Second call should include start_cursor
    expect(mockedAxios.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ start_cursor: 'cursor-abc' }),
      }),
    )
  })

  it('respects max_items limit', async () => {
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: {
        results: [{ id: '1' }, { id: '2' }, { id: '3' }],
        has_more: true,
        next_cursor: 'more',
      },
      headers: {},
    } as any)

    const result = await handlePaginatedFetch(
      { method: 'POST', path: '/v1/search', max_items: 2 },
      baseUrl, authHeaders, identity,
    )
    const content = JSON.parse(result.content[0].text)
    // Should stop after first fetch since we got enough items
    expect(content.results).toHaveLength(2)
    expect(mockedAxios).toHaveBeenCalledTimes(1)
  })

  it('handles non-paginated responses', async () => {
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: { object: 'page', id: 'abc' },
      headers: {},
    } as any)

    const result = await handlePaginatedFetch(
      { method: 'GET', path: '/v1/pages/abc' },
      baseUrl, authHeaders, identity,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.total_fetched).toBe(1)
    expect(content.data.object).toBe('page')
  })

  it('handles API errors', async () => {
    mockedAxios.mockResolvedValueOnce({
      status: 400,
      data: { object: 'error', message: 'bad request' },
      headers: {},
    } as any)

    const result = await handlePaginatedFetch(
      { method: 'POST', path: '/v1/search' },
      baseUrl, authHeaders, identity,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.status).toBe(400)
  })
})
