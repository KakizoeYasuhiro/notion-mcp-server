import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleBatchOperations, batchToolDefinition } from '../batch'
import axios from 'axios'

vi.mock('axios', () => ({
  default: vi.fn(),
}))

const mockedAxios = vi.mocked(axios)
const identity = (x: Record<string, unknown>) => x

const baseUrl = 'https://api.notion.com'
const authHeaders = { 'Authorization': 'Bearer test', 'Notion-Version': '2026-03-11' }

describe('batchToolDefinition', () => {
  it('has correct name', () => {
    expect(batchToolDefinition.name).toBe('notion-batch')
  })

  it('requires operations', () => {
    const schema = batchToolDefinition.inputSchema as any
    expect(schema.required).toContain('operations')
  })

  it('has destructiveHint', () => {
    expect(batchToolDefinition.annotations?.destructiveHint).toBe(true)
  })
})

describe('handleBatchOperations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects non-array operations', async () => {
    const result = await handleBatchOperations(
      { operations: 'not-array' },
      baseUrl, authHeaders, identity,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.status).toBe('error')
    expect(content.message).toContain('array')
  })

  it('rejects empty operations', async () => {
    const result = await handleBatchOperations(
      { operations: [] },
      baseUrl, authHeaders, identity,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.status).toBe('error')
    expect(content.message).toContain('empty')
  })

  it('rejects more than 20 operations', async () => {
    const ops = Array.from({ length: 21 }, (_, i) => ({
      method: 'GET', path: `/v1/pages/p${i}`,
    }))
    const result = await handleBatchOperations(
      { operations: ops },
      baseUrl, authHeaders, identity,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.status).toBe('error')
    expect(content.message).toContain('20')
  })

  it('executes multiple operations successfully', async () => {
    mockedAxios.mockResolvedValue({
      status: 200,
      data: { object: 'page' },
      headers: {},
    } as any)

    const result = await handleBatchOperations(
      {
        operations: [
          { method: 'PATCH', path: '/v1/pages/abc', body: { archived: true } },
          { method: 'PATCH', path: '/v1/pages/def', body: { archived: true } },
        ],
      },
      baseUrl, authHeaders, identity,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.summary.total).toBe(2)
    expect(content.summary.succeeded).toBe(2)
    expect(content.summary.failed).toBe(0)
    expect(mockedAxios).toHaveBeenCalledTimes(2)
  })

  it('continues after individual operation failure by default', async () => {
    mockedAxios
      .mockResolvedValueOnce({
        status: 400,
        data: { message: 'not found' },
        headers: {},
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: { object: 'page' },
        headers: {},
      } as any)

    const result = await handleBatchOperations(
      {
        operations: [
          { method: 'PATCH', path: '/v1/pages/bad' },
          { method: 'PATCH', path: '/v1/pages/good' },
        ],
      },
      baseUrl, authHeaders, identity,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.summary.succeeded).toBe(1)
    expect(content.summary.failed).toBe(1)
    expect(content.summary.executed).toBe(2)
  })

  it('stops on first error when stop_on_error is true', async () => {
    mockedAxios.mockResolvedValueOnce({
      status: 400,
      data: { message: 'error' },
      headers: {},
    } as any)

    const result = await handleBatchOperations(
      {
        operations: [
          { method: 'PATCH', path: '/v1/pages/bad' },
          { method: 'PATCH', path: '/v1/pages/good' },
        ],
        stop_on_error: true,
      },
      baseUrl, authHeaders, identity,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.summary.executed).toBe(1)
    expect(content.summary.failed).toBe(1)
    expect(mockedAxios).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid paths in operations', async () => {
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: {},
      headers: {},
    } as any)

    const result = await handleBatchOperations(
      {
        operations: [
          { method: 'GET', path: '/v2/bad' },
          { method: 'GET', path: '/v1/pages/good' },
        ],
      },
      baseUrl, authHeaders, identity,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.summary.failed).toBe(1)
    expect(content.summary.succeeded).toBe(1)
    expect(content.results[0].message).toContain('Invalid path')
  })
})
