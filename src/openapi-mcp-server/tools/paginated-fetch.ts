import axios from 'axios'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

/** Maximum total results to fetch across all pages */
const MAX_TOTAL_RESULTS = 500

/** Maximum response size in characters */
const MAX_RESPONSE_SIZE = 50000

/** Request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 30000

/** Delay between paginated requests to respect rate limits (ms) */
const RATE_LIMIT_DELAY_MS = 350

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Tool definition for auto-paginated fetch.
 */
export const paginatedFetchToolDefinition: Tool = {
  name: 'notion-paginated-fetch',
  description:
    'Notion | Auto-paginate through a Notion API endpoint that supports cursor-based pagination (has_more/next_cursor). ' +
    'Automatically follows next_cursor until all results are fetched (up to 500 items). ' +
    'Use for: POST /v1/search, POST /v1/data_sources/{id}/query, GET /v1/blocks/{id}/children, GET /v1/comments, GET /v1/users. ' +
    'Do NOT use for endpoints that do not return paginated results.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      method: {
        type: 'string',
        enum: ['GET', 'POST'],
        description: 'HTTP method. GET or POST only (paginated endpoints use one of these).',
      },
      path: {
        type: 'string',
        description: 'API path (e.g. "/v1/search", "/v1/blocks/abc123/children", "/v1/data_sources/xyz/query").',
      },
      body: {
        type: 'object',
        additionalProperties: true,
        description: 'Request body for POST endpoints (e.g. filters, sorts). start_cursor is managed automatically — do not include it.',
      },
      query: {
        type: 'object',
        additionalProperties: true,
        description: 'Query parameters for GET endpoints. start_cursor is managed automatically — do not include it.',
      },
      max_items: {
        type: 'number',
        description: 'Maximum number of items to fetch (default: 500, max: 500). Use a smaller number if you only need a few results.',
      },
    },
    required: ['method', 'path'],
  },
  annotations: {
    title: 'Paginated Fetch',
    readOnlyHint: true,
  },
}

/**
 * Validate path (reuse logic from raw-api).
 */
function isValidPath(path: string): boolean {
  if (!path || typeof path !== 'string') return false
  if (path.includes('?') || path.includes('#')) return false
  if (path.includes('..') || path.includes('//')) return false
  if (path.includes('%2e') || path.includes('%2E')) return false
  return /^\/v1\/[a-zA-Z0-9/_-]+$/.test(path)
}

/**
 * Handle auto-paginated fetch.
 */
export async function handlePaginatedFetch(
  params: Record<string, unknown>,
  baseUrl: string,
  authHeaders: Record<string, string>,
  deserializeParams: (p: Record<string, unknown>) => Record<string, unknown>,
) {
  const rawParams = deserializeParams(params)
  const method = ((rawParams.method as string) || 'GET').toUpperCase()
  const path = rawParams.path as string
  const body = rawParams.body as Record<string, unknown> | undefined
  const query = rawParams.query as Record<string, unknown> | undefined
  const maxItems = Math.min(Number(rawParams.max_items) || MAX_TOTAL_RESULTS, MAX_TOTAL_RESULTS)

  if (!isValidPath(path)) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ status: 'error', message: 'Invalid path. Must start with /v1/ and contain only safe characters.' }),
      }],
    }
  }

  if (!['GET', 'POST'].includes(method)) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ status: 'error', message: 'Only GET and POST are supported for paginated fetch.' }),
      }],
    }
  }

  const normalizedBase = baseUrl.replace(/\/+$/, '')
  const url = `${normalizedBase}${path}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'notion-mcp-server',
    ...authHeaders,
  }
  if (!headers['Notion-Version']) {
    headers['Notion-Version'] = '2026-03-11'
  }

  console.error(`[paginated-fetch] ${method} ${path} (max_items=${maxItems})`)

  const allResults: unknown[] = []
  let nextCursor: string | undefined = undefined
  let pageCount = 0

  try {
    while (allResults.length < maxItems) {
      const requestBody: Record<string, unknown> | undefined = method === 'POST'
        ? { ...body, ...(nextCursor ? { start_cursor: nextCursor } : {}) }
        : undefined
      const requestQuery: Record<string, unknown> | undefined = method === 'GET'
        ? { ...query, ...(nextCursor ? { start_cursor: nextCursor } : {}) }
        : query

      const response: { status: number; data: any; headers: Record<string, string> } = await axios({
        method: method.toLowerCase() as 'get' | 'post',
        url,
        headers,
        data: requestBody,
        params: requestQuery,
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      })

      if (response.status === 429) {
        const retryAfter = parseInt(response.headers['retry-after'] ?? '2', 10)
        console.error(`[paginated-fetch] Rate limited. Waiting ${retryAfter}s...`)
        await sleep(retryAfter * 1000)
        continue
      }

      if (response.status >= 400) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ status: response.status, data: response.data }),
          }],
        }
      }

      const data: any = response.data
      const results = data.results as unknown[] | undefined

      if (results) {
        allResults.push(...results)
      } else {
        // Non-paginated response, return as-is
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ status: 200, data, total_fetched: 1 }),
          }],
        }
      }

      pageCount++

      if (!data.has_more || !data.next_cursor) {
        break
      }

      nextCursor = data.next_cursor

      // Rate limit: wait between requests
      if (allResults.length < maxItems) {
        await sleep(RATE_LIMIT_DELAY_MS)
      }
    }

    const responseStr = JSON.stringify({
      status: 200,
      total_fetched: allResults.length,
      pages_fetched: pageCount,
      has_more: allResults.length >= maxItems,
      results: allResults.slice(0, maxItems),
    })

    // Truncate if too large
    if (responseStr.length > MAX_RESPONSE_SIZE) {
      const truncated = responseStr.slice(0, MAX_RESPONSE_SIZE)
      return {
        content: [{
          type: 'text' as const,
          text: `${truncated}...[TRUNCATED - ${allResults.length} items fetched across ${pageCount} pages]`,
        }],
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: responseStr,
      }],
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[paginated-fetch] Error: ${errMsg}`)
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'error',
          message: errMsg.includes('timeout') ? 'Request timed out (30s)' : 'Request failed',
          partial_results: allResults.length,
        }),
      }],
    }
  }
}
