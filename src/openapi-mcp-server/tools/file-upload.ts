import axios from 'axios'
import fs from 'node:fs'
import path from 'node:path'
import FormData from 'form-data'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

/** Request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 60000

/**
 * Tool definition for file upload.
 */
export const fileUploadToolDefinition: Tool = {
  name: 'notion-file-upload',
  description:
    'Notion | Upload a local file to Notion. This is a two-step process handled automatically: ' +
    '(1) creates a file upload object, (2) sends the file content. ' +
    'Returns the file upload ID which can then be attached to pages/blocks using other tools. ' +
    'Supported: images (png, jpg, gif, webp, svg), documents (pdf, txt, csv, docx, xlsx), audio, video. ' +
    'Max 5MiB (free) or 5GiB (paid). Upload expires in 1 hour if not attached to a page.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      file_path: {
        type: 'string',
        description:
          'Absolute path to the local file to upload (e.g. "/home/user/image.png"). Must exist and be readable.',
      },
      filename: {
        type: 'string',
        description: 'Optional filename override. Defaults to the basename of file_path.',
      },
      content_type: {
        type: 'string',
        description:
          'Optional MIME type (e.g. "image/png", "application/pdf"). Auto-detected from extension if omitted.',
      },
    },
    required: ['file_path'],
  },
  annotations: {
    title: 'File Upload',
    destructiveHint: false,
  },
}

/** Common MIME type mapping */
const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.zip': 'application/zip',
}

function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_TYPES[ext] || 'application/octet-stream'
}

/**
 * Handle file upload to Notion.
 */
export async function handleFileUpload(
  params: Record<string, unknown>,
  baseUrl: string,
  authHeaders: Record<string, string>,
  deserializeParams: (p: Record<string, unknown>) => Record<string, unknown>,
) {
  const rawParams = deserializeParams(params)
  const filePath = rawParams.file_path as string

  if (!filePath || typeof filePath !== 'string') {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ status: 'error', message: 'file_path is required' }),
      }],
    }
  }

  const filename = (rawParams.filename as string) || path.basename(filePath)
  const contentType = (rawParams.content_type as string) || detectMimeType(filePath)

  // Validate file exists and is readable
  try {
    fs.accessSync(filePath, fs.constants.R_OK)
  } catch {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ status: 'error', message: `File not found or not readable: ${filePath}` }),
      }],
    }
  }

  const stat = fs.statSync(filePath)
  if (!stat.isFile()) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ status: 'error', message: `Path is not a file: ${filePath}` }),
      }],
    }
  }

  const normalizedBase = baseUrl.replace(/\/+$/, '')
  const headers: Record<string, string> = {
    'User-Agent': 'notion-mcp-server',
    ...authHeaders,
  }
  if (!headers['Notion-Version']) {
    headers['Notion-Version'] = '2026-03-11'
  }

  console.error(`[file-upload] Uploading ${filename} (${contentType}, ${stat.size} bytes)`)

  try {
    // Step 1: Create file upload object
    const createResponse = await axios({
      method: 'post',
      url: `${normalizedBase}/v1/file_uploads`,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      data: {
        filename,
        content_type: contentType,
      },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    })

    if (createResponse.status >= 400) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: createResponse.status,
            step: 'create_upload',
            data: createResponse.data,
          }),
        }],
      }
    }

    const uploadId = createResponse.data.id
    if (!uploadId) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ status: 'error', message: 'No upload ID returned from create step' }),
        }],
      }
    }

    console.error(`[file-upload] Upload object created: ${uploadId}`)

    // Step 2: Send file content via multipart/form-data
    const formData = new FormData()
    formData.append('file', fs.createReadStream(filePath), {
      filename,
      contentType,
    })

    const sendResponse = await axios({
      method: 'post',
      url: `${normalizedBase}/v1/file_uploads/${uploadId}/send`,
      headers: {
        ...headers,
        ...formData.getHeaders(),
      },
      data: formData,
      timeout: REQUEST_TIMEOUT_MS,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true,
    })

    if (sendResponse.status >= 400) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: sendResponse.status,
            step: 'send_file',
            upload_id: uploadId,
            data: sendResponse.data,
          }),
        }],
      }
    }

    console.error(`[file-upload] File sent successfully: ${uploadId}`)

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 200,
          upload_id: uploadId,
          filename,
          content_type: contentType,
          size_bytes: stat.size,
          message: 'File uploaded. Use the upload_id to attach it to a page or block. Example: use patch-block-children with { type: "file", file: { type: "file_upload", file_upload: { id: "' + uploadId + '" } } }. Upload expires in 1 hour if not attached.',
        }),
      }],
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[file-upload] Error: ${errMsg}`)
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'error',
          message: errMsg.includes('timeout') ? 'Upload timed out (60s)' : 'Upload failed',
        }),
      }],
    }
  }
}
