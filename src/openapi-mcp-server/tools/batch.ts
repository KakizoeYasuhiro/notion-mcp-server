import axios from 'axios'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { REQUEST_TIMEOUT_MS, MAX_RESPONSE_SIZE, isValidPath, sleep } from './shared'

/** Maximum operations per batch */
const MAX_BATCH_SIZE = 20

/** Delay between operations to respect rate limits (ms) */
const RATE_LIMIT_DELAY_MS = 350

interface BatchOperation {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  path: string
  body?: Record<string, unknown>
}

interface BatchResult {
  index: number
  path: string
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
    'Use for independent bulk operations like archiving pages, updating properties on multiple pages, or deleting blocks. ' +
    'Do NOT use for dependent operations (where operation B needs the result of A) — use individual tools sequentially instead. ' +
    'Returns per-operation results with a summary including failed_operations for easy retry.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      operations: {
        type: 'array',
        description:
          'Array of independent operations to execute sequentially. Max 20. ' +
          'Each operation: { method, path, body? }. ' +
          'Example: [{ "method": "PATCH", "path": "/v1/pages/{id}", "body": { "archived": true } }]',
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
              description: 'API path (e.g. "/v1/pages/{page_id}"). Must start with /v1/.',
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
      content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', message: 'operations must be an array' }) }],
    }
  }

  if (operations.length === 0) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', message: 'operations array is empty' }) }],
    }
  }

  if (operations.length > MAX_BATCH_SIZE) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', message: `Max ${MAX_BATCH_SIZE} operations per batch. Got ${operations.length}.` }) }],
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
    const opPath = op.path

    if (!isValidPath(opPath)) {
      results.push({ index: i, path: opPath, status: 'error', message: `Invalid path: ${opPath}` })
      failed++
      if (stopOnError) break
      continue
    }

    const url = `${normalizedBase}${opPath}`
    console.error(`[batch] [${i + 1}/${operations.length}] ${method} ${opPath}`)

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
          const notionCode = response.data?.code || undefined
          const notionError = response.data?.message || `HTTP ${response.status}`
          results.push({ index: i, path: opPath, status: response.status, message: notionError, ...(notionCode ? { data: { code: notionCode } } : {}) })
          failed++
          if (stopOnError) break
        } else {
          // Success: keep only essential identifiers to prevent response bloat
          const d = response.data
          const minimized = (d && typeof d === 'object')
            ? Object.fromEntries(
                Object.entries(d).filter(([k]) => ['object', 'id', 'url', 'status'].includes(k))
              )
            : d
          results.push({ index: i, path: opPath, status: response.status, data: minimized })
          succeeded++
        }
        break
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error'
        if (attempt < 2 && errMsg.includes('ECONNRESET')) {
          await sleep(1000 * Math.pow(2, attempt))
          continue
        }
        results.push({ index: i, path: opPath, status: 'error', message: 'Request failed' })
        failed++
        if (stopOnError) break
        break
      }
    }

    if (stopOnError && failed > 0) break

    if (i < operations.length - 1) {
      await sleep(RATE_LIMIT_DELAY_MS)
    }
  }

  // P0: Extract failed_operations for easy identification
  const failedOperations = results
    .filter(r => r.status === 'error' || (typeof r.status === 'number' && r.status >= 400))
    .map(r => ({ index: r.index, path: r.path, status: r.status, message: r.message }))

  const summary = {
    total: operations.length,
    succeeded,
    failed,
    executed: results.length,
    ...(failedOperations.length > 0 ? { failed_operations: failedOperations } : {}),
  }

  // P1: Hint for retry
  const hint = failedOperations.length > 0
    ? `${failedOperations.length} operation(s) failed (indices: ${failedOperations.map(f => f.index).join(', ')}). You can retry just these by sending a new batch with only the failed operations.`
    : undefined

  const responseObj = {
    status: 200,
    summary,
    ...(hint ? { hint } : {}),
    results,
  }

  const responseStr = JSON.stringify(responseObj)

  if (responseStr.length > MAX_RESPONSE_SIZE) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 200,
          summary,
          ...(hint ? { hint } : {}),
          note: 'Full results truncated due to size. Only failed operations shown.',
        }),
      }],
    }
  }

  return {
    content: [{ type: 'text' as const, text: responseStr }],
  }
}
