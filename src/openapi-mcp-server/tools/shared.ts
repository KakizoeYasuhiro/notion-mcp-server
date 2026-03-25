/** Notion API version header value — single source of truth */
export const NOTION_API_VERSION = '2026-03-11'

/** Maximum response size in characters */
export const MAX_RESPONSE_SIZE = 50000

/** Request timeout in milliseconds */
export const REQUEST_TIMEOUT_MS = 30000

/** Strict path pattern */
export const SAFE_PATH_PATTERN = /^\/v1\/[a-zA-Z0-9/_-]+$/

/**
 * Known path patterns that map to dedicated tools.
 * Used by raw-api to suggest better alternatives.
 */
export const DEDICATED_TOOL_HINTS: Array<{ pattern: RegExp; tool: string; description: string }> = [
  {
    pattern: /^\/v1\/search$/,
    tool: 'API-post-search',
    description: 'Use the dedicated search tool for better schema validation',
  },
  {
    pattern: /^\/v1\/pages\/[^/]+$/,
    tool: 'API-retrieve-a-page or API-patch-page',
    description: 'Use dedicated page tools for retrieve/update',
  },
  {
    pattern: /^\/v1\/pages\/[^/]+\/markdown$/,
    tool: 'API-get-page-markdown or API-patch-page-markdown',
    description: 'Use dedicated markdown tools',
  },
  { pattern: /^\/v1\/pages$/, tool: 'API-post-page', description: 'Use the dedicated create page tool' },
  {
    pattern: /^\/v1\/blocks\/[^/]+\/children$/,
    tool: 'API-get-block-children or API-patch-block-children',
    description: 'Use dedicated block children tools',
  },
  {
    pattern: /^\/v1\/blocks\/[^/]+$/,
    tool: 'API-retrieve-a-block or API-update-a-block',
    description: 'Use dedicated block tools',
  },
  {
    pattern: /^\/v1\/data_sources\/[^/]+\/query$/,
    tool: 'API-query-data-source',
    description: 'Use the dedicated query tool',
  },
  {
    pattern: /^\/v1\/data_sources\/[^/]+$/,
    tool: 'API-retrieve-a-data-source',
    description: 'Use dedicated data source tools',
  },
  {
    pattern: /^\/v1\/comments$/,
    tool: 'API-retrieve-a-comment or API-create-a-comment',
    description: 'Use dedicated comment tools',
  },
  { pattern: /^\/v1\/users/, tool: 'API-get-user or API-get-users', description: 'Use dedicated user tools' },
]

/**
 * Find a dedicated tool hint for a given path.
 */
export function findDedicatedToolHint(path: string): string | null {
  for (const { pattern, tool, description } of DEDICATED_TOOL_HINTS) {
    if (pattern.test(path)) {
      return `${description}. Preferred tool: ${tool}`
    }
  }
  return null
}

/**
 * Validate and sanitize the API path to prevent SSRF and path injection.
 * Returns the sanitized path or null if invalid.
 */
export function validatePath(path: string): string | null {
  if (!path || typeof path !== 'string') return null
  if (path.includes('?') || path.includes('#')) return null
  if (path.includes('..')) return null
  if (path.includes('//')) return null
  if (path.includes('%2e') || path.includes('%2E')) return null
  if (!SAFE_PATH_PATTERN.test(path)) return null
  return path
}

/** Convenience alias: returns boolean for contexts that don't need the path back. */
export function isValidPath(path: string): boolean {
  return validatePath(path) !== null
}

/**
 * Structured Truncation: truncate response data while preserving valid JSON structure.
 *
 * For objects with a `results` array: removes items from the end until under size limit.
 * For other data: serializes and truncates with a descriptive message.
 * Always returns valid JSON.
 */
export function structuredTruncate(
  data: unknown,
  maxSize: number = MAX_RESPONSE_SIZE,
): {
  data: unknown
  truncated: boolean
  omitted_count?: number
  total?: number
} {
  const fullStr = JSON.stringify(data)
  if (fullStr.length <= maxSize) {
    return { data, truncated: false }
  }

  // If data is an object with a `results` array, truncate the array structurally
  if (data && typeof data === 'object' && 'results' in data && Array.isArray((data as any).results)) {
    const obj = { ...(data as Record<string, unknown>) }
    const fullResults = obj.results as unknown[]
    const total = fullResults.length

    // Binary search for the max number of results that fit
    let lo = 0
    let hi = total
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      const candidate = { ...obj, results: fullResults.slice(0, mid) }
      if (JSON.stringify(candidate).length <= maxSize - 500) {
        // 500 chars buffer for metadata
        lo = mid
      } else {
        hi = mid - 1
      }
    }

    const kept = Math.max(lo, 1) // Keep at least 1 item
    const truncatedObj = {
      ...obj,
      results: fullResults.slice(0, kept),
    }

    return {
      data: truncatedObj,
      truncated: true,
      omitted_count: total - kept,
      total,
    }
  }

  // For non-array responses (e.g., single large page), summarize
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    // Try to keep top-level keys but truncate large string values
    const summarized: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string' && value.length > 1000) {
        summarized[key] = `${value.slice(0, 1000)}... [truncated, original: ${value.length} chars]`
      } else if (Array.isArray(value) && JSON.stringify(value).length > maxSize / 2) {
        summarized[key] = value.slice(0, 5)
        summarized[`${key}_omitted_count`] = value.length - 5
        summarized[`${key}_total`] = value.length
      } else {
        summarized[key] = value
      }
    }
    const summarizedStr = JSON.stringify(summarized)
    if (summarizedStr.length <= maxSize) {
      return { data: summarized, truncated: true }
    }
  }

  // Last resort: provide key sizes for debugging
  const keySizes: Record<string, number> = {}
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      keySizes[k] = JSON.stringify(v).length
    }
  }
  return {
    data: {
      message: `Response too large (${fullStr.length} chars).`,
      key_sizes: keySizes,
      hint: 'Use more specific queries, filters, or pagination to reduce response size.',
    },
    truncated: true,
  }
}

/**
 * Build execution metadata (P2: Rate Limit metadata).
 * Only returns metadata if retries occurred.
 */
export function buildExecutionMetadata(retries: number, totalWaitMs: number): Record<string, unknown> | null {
  if (retries === 0) return null
  return {
    retries,
    total_wait_ms: totalWaitMs,
    hint: 'Rate limit was hit. Consider reducing batch size or adding delays between calls.',
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
