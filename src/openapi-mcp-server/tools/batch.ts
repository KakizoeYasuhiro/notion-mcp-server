import axios from 'axios'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

/** Maximum operations per batch */
const MAX_BATCH_SIZE = 20

/** Request timeout per operation (ms) */
const REQUEST_TIMEOUT_MS = 30000

/** Delay between operations to respect rate limits (ms) */
const RATE_LIMIT_DELAY_MS = 350

/** Maximum total response size */
const MAX_RESPONSE_SIZE = 50000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Validate path (same logic as raw-api).
 */
function isValidPath(path: string): boolean {
  if (!path || typeof path !== 'string') return false
  if (path.includes('?') || path.includes('#')) return false
  if (path.includes('..') || path.includes('//')) return false
  if (path.includes('%2e') || path.includes('%2E')) return false
  return /^\/v1\/[a-zA-Z0-9/_-]+$/.test(path)
}

interface BatchOperation {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  path: string
  body?: Record<string, unknown>
}

interface BatchResult {
  index: number
  status: number | 'error'
  data?: unknown
  message?: string
}

/**
 * Tool definition for batch operations.
 */
export const batchToolDefinition: Tool = {
  name: 'notion-batch',
  description:
    'Notion | Execute multiple Notion API operations in sequence with automatic rate-limit handling. ' +
    'Max 20 operations per batch. Operations run sequentially (not parallel) to respect Notion rate limits. ' +
    'Use for bulk updates like archiving pages, updating properties on multiple pages, or deleting blocks. ' +
    'Each operation is independent — failures do not stop subsequent operations. ' +
    'Returns per-operation results.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      operations: {
        type: 'array',
        description: 'Array of operations to execute sequentially. Max 20.',
        items: {
          type: 'object',
          properties: {
            method: {
              type: 'string',
              enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
              description: 'HTTP method.',
            },
            path: {
              type: 'string',
              description: 'API path (e.g. "/v1/pages/abc123"). Must start with /v1/.',
            },
            body: {
              type: 'object',
              additionalProperties: true,
              description: 'Request body (for POST/PATCH/PUT).',
            },
          },
          required: ['method', 'path'],
        },
      },
      stop_on_error: {
        type: 'boolean',
        description: 'If true, stop executing remaining operations after the first error (default: false).',
      },
    },
    required: ['operations'],
  },
  annotations: {
    title: 'Batch Operations',
    destructiveHint: true,
  },
}

/**
 * Handle batch operations.
 */
export async function handleBatchOperations(
  params: Record<string, unknown>,
  baseUrl: string,
  authHeaders: Record<string, string>,
  deserializeParams: (p: Record<string, unknown>) => Record<string, unknown>,
) {
  const rawParams = deserializeParams(params)
  const operations = rawParams.operations as BatchOperation[] | undefined
  const stopOnError = rawParams.stop_on_error as boolean | undefined

  if (!operations || !Array.isArray(operations)) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ status: 'error', message: 'operations must be an array' }),
      }],
    }
  }

  if (operations.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ status: 'error', message: 'operations array is empty' }),
      }],
    }
  }

  if (operations.length > MAX_BATCH_SIZE) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ status: 'error', message: `Max ${MAX_BATCH_SIZE} operations per batch. Got ${operations.length}.` }),
      }],
    }
  }

  const normalizedBase = baseUrl.replace(/\/+$/, '')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'notion-mcp-server',
    ...authHeaders,
  }
  if (!headers['Notion-Version']) {
    headers['Notion-Version'] = '2026-03-11'
  }

  console.error(`[batch] Starting ${operations.length} operations`)

  const results: BatchResult[] = []
  let succeeded = 0
  let failed = 0

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i]
    const method = (op.method || 'GET').toUpperCase()
    const path = op.path

    if (!isValidPath(path)) {
      results.push({ index: i, status: 'error', message: `Invalid path: ${path}` })
      failed++
      if (stopOnError) break
      continue
    }

    const url = `${normalizedBase}${path}`
    console.error(`[batch] [${i + 1}/${operations.length}] ${method} ${path}`)

    // Retry loop for rate limits
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await axios({
          method: method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete',
          url,
          headers,
          data: ['POST', 'PATCH', 'PUT'].includes(method) ? op.body : undefined,
          timeout: REQUEST_TIMEOUT_MS,
          validateStatus: () => true,
        })

        if (response.status === 429) {
          const retryAfter = parseInt(response.headers['retry-after'] ?? '2', 10)
          console.error(`[batch] Rate limited at operation ${i}. Waiting ${retryAfter}s...`)
          await sleep(retryAfter * 1000)
          continue
        }

        if (response.status >= 400) {
          // Extract Notion error message if available
          const notionError = response.data?.message || response.data?.code || `HTTP ${response.status}`
          results.push({ index: i, status: response.status, message: notionError })
          failed++
          if (stopOnError) break
        } else {
          results.push({ index: i, status: response.status, data: response.data })
          succeeded++
        }
        break
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error'
        if (attempt < 2 && errMsg.includes('ECONNRESET')) {
          await sleep(1000 * Math.pow(2, attempt))
          continue
        }
        results.push({ index: i, status: 'error', message: 'Request failed' })
        failed++
        if (stopOnError) break
        break
      }
    }

    if (stopOnError && failed > 0) break

    // Rate limit delay between operations
    if (i < operations.length - 1) {
      await sleep(RATE_LIMIT_DELAY_MS)
    }
  }

  const responseStr = JSON.stringify({
    status: 200,
    summary: { total: operations.length, succeeded, failed, executed: results.length },
    results,
  })

  if (responseStr.length > MAX_RESPONSE_SIZE) {
    // Summarize instead of full results
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 200,
          summary: { total: operations.length, succeeded, failed, executed: results.length },
          note: 'Full results truncated due to size. Individual results omitted.',
          errors: results.filter(r => r.status === 'error' || (typeof r.status === 'number' && r.status >= 400)),
        }),
      }],
    }
  }

  return {
    content: [{
      type: 'text' as const,
      text: responseStr,
    }],
  }
}
