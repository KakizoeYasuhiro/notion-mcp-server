import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleFileUpload, fileUploadToolDefinition } from '../file-upload'
import axios from 'axios'
import fs from 'node:fs'
import { Readable } from 'node:stream'

vi.mock('axios', () => ({
  default: vi.fn(),
}))

const mockedAxios = vi.mocked(axios)
const identity = (x: Record<string, unknown>) => x

const baseUrl = 'https://api.notion.com'
const authHeaders = { 'Authorization': 'Bearer test', 'Notion-Version': '2026-03-11' }

describe('fileUploadToolDefinition', () => {
  it('has correct name', () => {
    expect(fileUploadToolDefinition.name).toBe('notion-file-upload')
  })

  it('requires file_path', () => {
    const schema = fileUploadToolDefinition.inputSchema as any
    expect(schema.required).toContain('file_path')
  })
})

describe('handleFileUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects missing file_path', async () => {
    const result = await handleFileUpload(
      {} as any,
      baseUrl, authHeaders, identity,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.status).toBe('error')
    expect(content.message).toContain('file_path')
  })

  it('rejects non-existent files', async () => {
    const result = await handleFileUpload(
      { file_path: '/tmp/nonexistent-file-abc123.xyz' },
      baseUrl, authHeaders, identity,
    )
    const content = JSON.parse(result.content[0].text)
    expect(content.status).toBe('error')
    expect(content.message).toContain('not found')
  })

  it('uploads file successfully (two-step)', async () => {
    // Create a temporary test file
    const tmpFile = '/tmp/notion-mcp-test-upload.txt'
    fs.writeFileSync(tmpFile, 'test content')

    try {
      // Step 1: create upload object
      mockedAxios
        .mockResolvedValueOnce({
          status: 200,
          data: { id: 'upload-123', status: 'pending' },
          headers: {},
        } as any)
        // Step 2: send file
        .mockResolvedValueOnce({
          status: 200,
          data: { id: 'upload-123', status: 'uploaded' },
          headers: {},
        } as any)

      const result = await handleFileUpload(
        { file_path: tmpFile },
        baseUrl, authHeaders, identity,
      )
      const content = JSON.parse(result.content[0].text)
      expect(content.status).toBe(200)
      expect(content.upload_id).toBe('upload-123')
      expect(content.filename).toBe('notion-mcp-test-upload.txt')
      expect(content.content_type).toBe('text/plain')
      expect(mockedAxios).toHaveBeenCalledTimes(2)

      // Verify step 1 called /v1/file_uploads
      expect(mockedAxios.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          url: 'https://api.notion.com/v1/file_uploads',
          method: 'post',
        }),
      )

      // Verify step 2 called /v1/file_uploads/{id}/send
      expect(mockedAxios.mock.calls[1][0]).toEqual(
        expect.objectContaining({
          url: 'https://api.notion.com/v1/file_uploads/upload-123/send',
          method: 'post',
        }),
      )
    } finally {
      fs.unlinkSync(tmpFile)
    }
  })

  it('handles API error in create step', async () => {
    const tmpFile = '/tmp/notion-mcp-test-upload2.txt'
    fs.writeFileSync(tmpFile, 'test')

    try {
      mockedAxios.mockResolvedValueOnce({
        status: 400,
        data: { message: 'bad request' },
        headers: {},
      } as any)

      const result = await handleFileUpload(
        { file_path: tmpFile },
        baseUrl, authHeaders, identity,
      )
      const content = JSON.parse(result.content[0].text)
      expect(content.status).toBe(400)
      expect(content.step).toBe('create_upload')
    } finally {
      fs.unlinkSync(tmpFile)
    }
  })

  it('detects MIME type from extension', async () => {
    const tmpFile = '/tmp/notion-mcp-test.png'
    fs.writeFileSync(tmpFile, 'fake-png')

    try {
      mockedAxios
        .mockResolvedValueOnce({
          status: 200,
          data: { id: 'up-1' },
          headers: {},
        } as any)
        .mockResolvedValueOnce({
          status: 200,
          data: { id: 'up-1', status: 'uploaded' },
          headers: {},
        } as any)

      const result = await handleFileUpload(
        { file_path: tmpFile },
        baseUrl, authHeaders, identity,
      )
      const content = JSON.parse(result.content[0].text)
      expect(content.content_type).toBe('image/png')
    } finally {
      fs.unlinkSync(tmpFile)
    }
  })

  it('uses custom filename and content_type', async () => {
    const tmpFile = '/tmp/notion-mcp-test3.bin'
    fs.writeFileSync(tmpFile, 'data')

    try {
      mockedAxios
        .mockResolvedValueOnce({
          status: 200,
          data: { id: 'up-2' },
          headers: {},
        } as any)
        .mockResolvedValueOnce({
          status: 200,
          data: { id: 'up-2', status: 'uploaded' },
          headers: {},
        } as any)

      const result = await handleFileUpload(
        { file_path: tmpFile, filename: 'report.pdf', content_type: 'application/pdf' },
        baseUrl, authHeaders, identity,
      )
      const content = JSON.parse(result.content[0].text)
      expect(content.filename).toBe('report.pdf')
      expect(content.content_type).toBe('application/pdf')

      // Verify create step used custom filename
      expect(mockedAxios.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            filename: 'report.pdf',
            content_type: 'application/pdf',
          }),
        }),
      )
    } finally {
      fs.unlinkSync(tmpFile)
    }
  })
})
