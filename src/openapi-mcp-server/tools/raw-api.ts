import axios from 'axios'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

/** Maximum response size in characters before truncation */
const MAX_RESPONSE_SIZE = 50000

/** Request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 30000

/** Max retry attempts for rate-limited requests */
const MAX_RETRIES = 3

/** Strict path pattern: /v1/ followed by alphanumeric, hyphens, underscores, slashes only */
const SAFE_PATH_PATTERN = /^\/v1\/[a-zA-Z0-9/_-]+$/

/**
 * Validate and sanitize the API path to prevent SSRF and path injection.
 * Returns the sanitized path or null if invalid.
 */
export function validatePath(path: string): string | null {
  if (!path || typeof path !== 'string') return null

  // Reject paths with query strings embedded (must use query parameter)
  if (path.includes('?') || path.includes('#')) return null

  // Reject path traversal
  if (path.includes('..')) return null

  // Reject double slashes (protocol-relative URL or malformed path)
  if (path.includes('//')) return null

  // Reject URL-encoded dots that could bypass traversal check
  if (path.includes('%2e') || path.includes('%2E')) return null

  // Must match strict pattern
  if (!SAFE_PATH_PATTERN.test(path)) return null

  return path
}

/**
 * Truncate response data if it exceeds the maximum size.
 */
function truncateResponse(data: unknown): { data: unknown; truncated: boolean } {
  const str = JSON.stringify(data)
  if (str.length <= MAX_RESPONSE_SIZE) {
    return { data, truncated: false }
  }
  const truncated = str.slice(0, MAX_RESPONSE_SIZE)
  try {
    // Try to return valid JSON by parsing what we can
    return { data: `${truncated}...[TRUNCATED - original size: ${str.length} chars]`, truncated: true }
  } catch {
    return { data: `${truncated}...[TRUNCATED]`, truncated: true }
  }
}

/**
 * Sleep for exponential backoff
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Tool definition for the raw API tool.
 */
export const rawApiToolDefinition: Tool = {
  name: 'notion-raw-api',
  description:
    'Notion | Execute an arbitrary Notion API endpoint. ' +
    'ONLY use this when no predefined tool covers the operation — predefined tools have validated schemas and better error handling. ' +
    'Specify HTTP method, path (e.g. "/v1/databases/{db_id}/query"), and optional body/query. ' +
    'Responses are truncated at 50KB.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
        description: 'HTTP method. DELETE is destructive and cannot be undone.',
      },
      path: {
        type: 'string',
        description:
          'API path starting with /v1/. Examples: "/v1/pages/abc123", "/v1/databases/xyz/query", "/v1/blocks/abc/children". ' +
          'Must not contain query strings (use the query parameter instead), "..", or "//".',
      },
      body: {
        type: 'object',
        additionalProperties: true,
        description:
          'JSON request body (for POST/PATCH/PUT). Must match the Notion API documentation for the endpoint being called.',
      },
      query: {
        type: 'object',
        additionalProperties: true,
        description: 'Query parameters as key-value pairs (e.g. {"page_size": 10, "start_cursor": "abc"}).',
      },
    },
    required: ['method', 'path'],
  },
  annotations: {
    title: 'Raw API Call',
    destructiveHint: true,
  },
}

/**
 * Handle a raw API call to the Notion API.
 * Includes path validation, rate limit retry, timeout, response truncation, and audit logging.
 */
export async function handleRawApiCall(
  params: Record<string, unknown>,
  baseUrl: string,
  authHeaders: Record<string, string>,
  deserializeParams: (p: Record<string, unknown>) => Record<string, unknown>,
) {
  const rawParams = deserializeParams(params)
  const method = (rawParams.method as string || 'GET').toUpperCase()
  const path = rawParams.path as string
  const body = rawParams.body as Record<string, unknown> | undefined
  const query = rawParams.query as Record<string, unknown> | undefined

  // H2: Strict path validation
  const validPath = validatePath(path)
  if (!validPath) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            status: 'error',
            message:
              'Invalid path. Must start with /v1/, contain only alphanumeric/hyphens/underscores/slashes, ' +
              'and must not contain "..", "//", query strings, or encoded characters.',
          }),
        },
      ],
    }
  }

  // M8: Normalize baseUrl (remove trailing slash)
  const normalizedBase = baseUrl.replace(/\/+$/, '')
  const url = `${normalizedBase}${validPath}`

  // Validate final URL points to expected host
  try {
    const parsed = new URL(url)
    if (!parsed.hostname.endsWith('notion.com')) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status: 'error',
              message: 'Request URL must target notion.com',
            }),
          },
        ],
      }
    }
  } catch {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ status: 'error', message: 'Invalid URL construction' }),
        },
      ],
    }
  }

  // H4: Ensure Notion-Version header is always present
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'notion-mcp-server',
    ...authHeaders,
  }
  if (!headers['Notion-Version']) {
    headers['Notion-Version'] = '2026-03-11'
  }

  // M4: Audit log
  console.error(`[raw-api] ${method} ${validPath}${query ? ` query=${JSON.stringify(query)}` : ''}`)

  // H5: Retry with exponential backoff for rate limits
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios({
        method: method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete',
        url,
        headers,
        data: ['POST', 'PATCH', 'PUT'].includes(method) ? body : undefined,
        params: query,
        timeout: REQUEST_TIMEOUT_MS, // H6: Timeout
        validateStatus: () => true,
      })

      // H5: Handle rate limiting with retry
      if (response.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = parseInt(response.headers['retry-after'] ?? '1', 10)
        const backoffMs = Math.min(retryAfter * 1000, 5000) * Math.pow(2, attempt)
        console.error(`[raw-api] Rate limited (429). Retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`)
        await sleep(backoffMs)
        continue
      }

      // H3: Truncate large responses
      const { data: responseData, truncated } = truncateResponse(response.data)

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status: response.status,
              data: responseData,
              ...(truncated ? { truncated: true } : {}),
            }),
          },
        ],
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error'
      // Don't leak full error details - just the message
      console.error(`[raw-api] Error: ${errMsg}`)

      if (attempt < MAX_RETRIES && errMsg.includes('ECONNRESET')) {
        await sleep(1000 * Math.pow(2, attempt))
        continue
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status: 'error',
              message: errMsg.includes('timeout') ? 'Request timed out (30s)' : 'Request failed',
            }),
          },
        ],
      }
    }
  }

  // Should not reach here, but just in case
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ status: 'error', message: 'Max retries exceeded' }),
      },
    ],
  }
}
