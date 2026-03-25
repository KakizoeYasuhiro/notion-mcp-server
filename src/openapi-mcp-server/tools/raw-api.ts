import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import axios from 'axios'
import {
  buildExecutionMetadata,
  findDedicatedToolHint,
  NOTION_API_VERSION,
  REQUEST_TIMEOUT_MS,
  sleep,
  structuredTruncate,
  validatePath,
} from './shared'

// Re-export validatePath for existing test compatibility
export { validatePath } from './shared'

/** Max retry attempts for rate-limited requests */
const MAX_RETRIES = 3

/**
 * Tool definition for the raw API tool.
 */
export const rawApiToolDefinition: Tool = {
  name: 'notion-raw-api',
  description:
    'Notion | Execute an arbitrary Notion API endpoint. ' +
    'ONLY use this when no predefined tool covers the operation — predefined tools have validated schemas and better error handling. ' +
    'Specify HTTP method, path, and optional body/query. Responses are structurally truncated at 50KB (JSON structure preserved). ' +
    'Common paths: /v1/pages/{id}, /v1/blocks/{id}/children, /v1/data_sources/{id}/query, /v1/search, /v1/comments, /v1/users, /v1/file_uploads.',
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
          'API path starting with /v1/. Examples: "/v1/pages/{page_id}", "/v1/blocks/{block_id}/children", ' +
          '"/v1/data_sources/{data_source_id}/query", "/v1/file_uploads". ' +
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
 */
export async function handleRawApiCall(
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

  const normalizedBase = baseUrl.replace(/\/+$/, '')
  const url = `${normalizedBase}${validPath}`

  try {
    const parsed = new URL(url)
    if (!parsed.hostname.endsWith('notion.com')) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ status: 'error', message: 'Request URL must target notion.com' }),
          },
        ],
      }
    }
  } catch {
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ status: 'error', message: 'Invalid URL construction' }) },
      ],
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'notion-mcp-server',
    ...authHeaders,
  }
  if (!headers['Notion-Version']) {
    headers['Notion-Version'] = NOTION_API_VERSION
  }

  console.error(`[raw-api] ${method} ${validPath}${query ? ` query=${JSON.stringify(query)}` : ''}`)

  // P1: Check for dedicated tool overlap
  const dedicatedHint = findDedicatedToolHint(validPath)

  // P2: Track retries for metadata
  let retryCount = 0
  let totalWaitMs = 0

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios({
        method: method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete',
        url,
        headers,
        data: ['POST', 'PATCH', 'PUT'].includes(method) ? body : undefined,
        params: query,
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      })

      if (response.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = parseInt(response.headers['retry-after'] ?? '1', 10)
        const backoffMs = Math.min(retryAfter * 1000, 5000) * 2 ** attempt
        console.error(
          `[raw-api] Rate limited (429). Retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        )
        retryCount++
        totalWaitMs += backoffMs
        await sleep(backoffMs)
        continue
      }

      // P0: Structured truncation
      const { data: responseData, truncated, omitted_count, total } = structuredTruncate(response.data)

      // P2: Execution metadata (only if retries occurred)
      const executionMetadata = buildExecutionMetadata(retryCount, totalWaitMs)

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status: response.status,
              data: responseData,
              ...(truncated ? { truncated: true, omitted_count, total } : {}),
              ...(truncated ? { hint: 'Use notion-paginated-fetch for this endpoint to get all results.' } : {}),
              ...(dedicatedHint ? { tool_hint: dedicatedHint } : {}),
              ...(executionMetadata ? { execution_metadata: executionMetadata } : {}),
            }),
          },
        ],
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error'
      console.error(`[raw-api] Error: ${errMsg}`)

      if (attempt < MAX_RETRIES && errMsg.includes('ECONNRESET')) {
        retryCount++
        const waitMs = 1000 * 2 ** attempt
        totalWaitMs += waitMs
        await sleep(waitMs)
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

  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', message: 'Max retries exceeded' }) }],
  }
}
