jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class CollaborationGateway {},
}));

import { McpService } from './mcp.service';
import {
  MCP_UPLOAD_MAX_BASE64_CHARS,
  MCP_UPLOAD_MAX_BINARY_BYTES,
  MCP_MANUAL_UPLOAD_GUIDANCE,
} from './mcp.body-limit';

const pageId = '0b6f8a3e-5c1d-4e2a-9f47-1a2b3c4d5e01';
const user = { id: 'user-1', workspaceId: 'ws-1' } as any;
const workspace = { id: 'ws-1' } as any;
const decode = (result: any) => JSON.parse(result.content[0].text);

function subject() {
  const service = Object.create(McpService.prototype) as any;
  const attachmentService = {
    uploadFile: jest.fn().mockResolvedValue({
      id: 'att-1',
      fileName: 'small.bin',
      mimeType: 'application/octet-stream',
      fileSize: 3,
    }),
  };
  Object.assign(service, {
    pageRepo: {
      findById: jest
        .fn()
        .mockResolvedValue({ id: pageId, workspaceId: 'ws-1', spaceId: 'sp-1' }),
    },
    pageAccessService: { validateCanEdit: jest.fn().mockResolvedValue(true) },
    attachmentService,
  });
  return { service, attachmentService };
}

const ctx = { user, workspace } as any;

describe('upload_attachment size guard', () => {
  it('rejects an oversized payload with manual-upload guidance', async () => {
    const { service, attachmentService } = subject();
    const oversized = 'A'.repeat(MCP_UPLOAD_MAX_BASE64_CHARS + 4);

    const result = await service.runTool(() =>
      service.uploadAttachment(ctx, {
        pageId,
        fileName: 'huge.bin',
        contentBase64: oversized,
      }),
    );

    expect(result.isError).toBe(true);
    const body = decode(result);
    expect(body.code).toBe('FILE_TOO_LARGE');
    expect(body.error).toContain(MCP_MANUAL_UPLOAD_GUIDANCE);
    expect(body.details).toMatchObject({
      maxBase64Chars: MCP_UPLOAD_MAX_BASE64_CHARS,
      maxBinaryBytes: MCP_UPLOAD_MAX_BINARY_BYTES,
      remediation: 'manual_upload_in_akasha',
    });
    expect(attachmentService.uploadFile).not.toHaveBeenCalled();
  });

  it('does not decode the payload before rejecting it', async () => {
    const { service } = subject();
    const spy = jest.spyOn(Buffer, 'from');
    const oversized = 'A'.repeat(MCP_UPLOAD_MAX_BASE64_CHARS + 4);

    await service.runTool(() =>
      service.uploadAttachment(ctx, {
        pageId,
        fileName: 'huge.bin',
        contentBase64: oversized,
      }),
    );

    const decodedOversized = spy.mock.calls.some(
      ([value]) => typeof value === 'string' && value.length > 1_000_000,
    );
    expect(decodedOversized).toBe(false);
    spy.mockRestore();
  });

  it('still uploads a payload within the limit', async () => {
    const { service, attachmentService } = subject();

    const result = await service.runTool(() =>
      service.uploadAttachment(ctx, {
        pageId,
        fileName: 'small.bin',
        contentBase64: Buffer.from('abc').toString('base64'),
      }),
    );

    expect(result.isError).toBeUndefined();
    expect(decode(result).attachmentId).toBe('att-1');
    expect(attachmentService.uploadFile).toHaveBeenCalledTimes(1);
  });
});
