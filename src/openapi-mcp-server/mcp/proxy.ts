import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import type { JSONSchema7 as IJsonSchema } from 'json-schema'
import type { OpenAPIV3 } from 'openapi-types'
import { HttpClient, HttpClientError } from '../client/http-client'
import { OpenAPIToMCPConverter } from '../openapi/parser'
import { batchToolDefinition, handleBatchOperations } from '../tools/batch'
import { fileUploadToolDefinition, handleFileUpload } from '../tools/file-upload'
import { handlePaginatedFetch, paginatedFetchToolDefinition } from '../tools/paginated-fetch'
import { handleRawApiCall, rawApiToolDefinition } from '../tools/raw-api'
import { NOTION_API_VERSION } from '../tools/shared'

type PathItemObject = OpenAPIV3.PathItemObject & {
  get?: OpenAPIV3.OperationObject
  put?: OpenAPIV3.OperationObject
  post?: OpenAPIV3.OperationObject
  delete?: OpenAPIV3.OperationObject
  patch?: OpenAPIV3.OperationObject
}

type NewToolDefinition = {
  methods: Array<{
    name: string
    description: string
    inputSchema: IJsonSchema & { type: 'object' }
    returnSchema?: IJsonSchema
  }>
}

/**
 * Recursively deserialize stringified JSON values in parameters.
 * This handles the case where MCP clients (like Cursor, Claude Code) double-serialize
 * nested object parameters, sending them as JSON strings instead of objects.
 *
 * @see https://github.com/makenotion/notion-mcp-server/issues/176
 */
function deserializeParams(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') {
      // Check if the string looks like a JSON object or array
      const trimmed = value.trim()
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          const parsed = JSON.parse(value)
          // Only use parsed value if it's an object or array
          if (typeof parsed === 'object' && parsed !== null) {
            // Recursively deserialize nested objects
            result[key] = Array.isArray(parsed) ? parsed : deserializeParams(parsed as Record<string, unknown>)
            continue
          }
        } catch {
          // If parsing fails, keep the original string value
        }
      }
    } else if (Array.isArray(value)) {
      // Deserialize any JSON-string items within the array
      result[key] = value.map((item) => {
        if (typeof item !== 'string') return item
        const trimmed = item.trim()
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
          try {
            const parsed = JSON.parse(item)
            if (typeof parsed === 'object' && parsed !== null) {
              return Array.isArray(parsed) ? parsed : deserializeParams(parsed as Record<string, unknown>)
            }
          } catch {
            // If parsing fails, keep the original string item
          }
        }
        return item
      })
      continue
    }
    result[key] = value
  }

  return result
}

// import this class, extend and return server
export class MCPProxy {
  private server: Server
  private httpClient: HttpClient
  private tools: Record<string, NewToolDefinition>
  private openApiLookup: Record<string, OpenAPIV3.OperationObject & { method: string; path: string }>
  private baseUrl: string
  private authHeaders: Record<string, string>

  constructor(name: string, openApiSpec: OpenAPIV3.Document) {
    this.server = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } })
    this.baseUrl = openApiSpec.servers?.[0].url ?? ''
    if (!this.baseUrl) {
      throw new Error('No base URL found in OpenAPI spec')
    }
    this.authHeaders = this.parseHeadersFromEnv()
    this.httpClient = new HttpClient(
      {
        baseUrl: this.baseUrl,
        headers: this.authHeaders,
      },
      openApiSpec,
    )

    // Convert OpenAPI spec to MCP tools
    const converter = new OpenAPIToMCPConverter(openApiSpec)
    const { tools, openApiLookup } = converter.convertToMCPTools()
    this.tools = tools
    this.openApiLookup = openApiLookup

    this.setupHandlers()
  }

  private setupHandlers() {
    // Handle tool listing
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = []

      // Add methods as separate tools to match the MCP format
      Object.entries(this.tools).forEach(([toolName, def]) => {
        def.methods.forEach((method) => {
          const toolNameWithMethod = `${toolName}-${method.name}`
          const truncatedToolName = this.truncateToolName(toolNameWithMethod)

          // Look up the HTTP method to determine annotations
          const operation = this.openApiLookup[toolNameWithMethod]
          const httpMethod = operation?.method?.toLowerCase()
          const isReadOnly = httpMethod === 'get'

          tools.push({
            name: truncatedToolName,
            description: method.description,
            inputSchema: method.inputSchema as Tool['inputSchema'],
            annotations: {
              title: this.operationIdToTitle(method.name),
              ...(isReadOnly ? { readOnlyHint: true } : { destructiveHint: true }),
            },
          })
        })
      })

      // Add custom tools (from external modules)
      tools.push(rawApiToolDefinition)
      tools.push(paginatedFetchToolDefinition)
      tools.push(batchToolDefinition)
      tools.push(fileUploadToolDefinition)

      return { tools }
    })

    // Handle tool calling
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: params } = request.params

      // Handle custom tools (delegated to external modules)
      if (name === 'notion-raw-api') {
        return handleRawApiCall(params as Record<string, unknown>, this.baseUrl, this.authHeaders, deserializeParams)
      }
      if (name === 'notion-paginated-fetch') {
        return handlePaginatedFetch(
          params as Record<string, unknown>,
          this.baseUrl,
          this.authHeaders,
          deserializeParams,
        )
      }
      if (name === 'notion-batch') {
        return handleBatchOperations(
          params as Record<string, unknown>,
          this.baseUrl,
          this.authHeaders,
          deserializeParams,
        )
      }
      if (name === 'notion-file-upload') {
        return handleFileUpload(params as Record<string, unknown>, this.baseUrl, this.authHeaders, deserializeParams)
      }

      // Find the operation in OpenAPI spec
      const operation = this.findOperation(name)
      if (!operation) {
        throw new Error(`Method ${name} not found`)
      }

      // Deserialize any stringified JSON parameters (fixes double-serialization bug)
      // See: https://github.com/makenotion/notion-mcp-server/issues/176
      const deserializedParams = params ? deserializeParams(params as Record<string, unknown>) : {}

      try {
        // Execute the operation
        const response = await this.httpClient.executeOperation(operation, deserializedParams)

        // Convert response to MCP format
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ status: response.status, data: response.data }),
            },
          ],
        }
      } catch (error) {
        console.error('Error in tool call', error instanceof Error ? error.message : 'Unknown error')
        if (error instanceof HttpClientError) {
          console.error('HttpClientError encountered, returning structured error', { status: error.status })
          const data = error.data?.response?.data ?? error.data ?? {}
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: error.status,
                  ...(typeof data === 'object' ? data : { data: data }),
                }),
              },
            ],
          }
        }
        const message = error instanceof Error ? error.message : 'Unknown error'
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'error',
                message,
              }),
            },
          ],
        }
      }
    })
  }

  private findOperation(operationId: string): (OpenAPIV3.OperationObject & { method: string; path: string }) | null {
    return this.openApiLookup[operationId] ?? null
  }

  private parseHeadersFromEnv(): Record<string, string> {
    // First try OPENAPI_MCP_HEADERS (existing behavior)
    const headersJson = process.env.OPENAPI_MCP_HEADERS
    if (headersJson) {
      try {
        const headers = JSON.parse(headersJson)
        if (typeof headers !== 'object' || headers === null) {
          console.warn('OPENAPI_MCP_HEADERS environment variable must be a JSON object, got:', typeof headers)
        } else if (Object.keys(headers).length > 0) {
          // Only use OPENAPI_MCP_HEADERS if it contains actual headers
          return headers
        }
        // If OPENAPI_MCP_HEADERS is empty object, fall through to try NOTION_TOKEN
      } catch (error) {
        console.warn('Failed to parse OPENAPI_MCP_HEADERS environment variable:', error)
        // Fall through to try NOTION_TOKEN
      }
    }

    // Alternative: try NOTION_TOKEN
    const notionToken = process.env.NOTION_TOKEN
    if (notionToken) {
      return {
        Authorization: `Bearer ${notionToken}`,
        'Notion-Version': NOTION_API_VERSION,
      }
    }

    return {}
  }

  private truncateToolName(name: string): string {
    if (name.length <= 64) {
      return name
    }
    return name.slice(0, 64)
  }

  /**
   * Convert an operationId like "createDatabase" to a human-readable title like "Create Database"
   */
  private operationIdToTitle(operationId: string): string {
    // Split on camelCase boundaries and capitalize each word
    return operationId
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_-]+/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  }

  async connect(transport: Transport) {
    // The SDK will handle stdio communication
    await this.server.connect(transport)
  }

  getServer() {
    return this.server
  }
}
