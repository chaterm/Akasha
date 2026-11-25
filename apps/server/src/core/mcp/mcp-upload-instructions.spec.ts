jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class CollaborationGateway {},
}));

import { ForbiddenException } from '@nestjs/common';
import { McpService } from './mcp.service';

const pageId = '0b6f8a3e-5c1d-4e2a-9f47-1a2b3c4d5e01';
const user = { id: 'user-1', workspaceId: 'ws-1' } as any;
const workspace = { id: 'ws-1', hostname: 'acme' } as any;
const decode = (result: any) => JSON.parse(result.content[0].text);

function subject(overrides: Record<string, any> = {}) {
  const service = Object.create(McpService.prototype) as any;
  const pageAccessService = {
    validateCanEdit: jest.fn().mockResolvedValue({ hasRestriction: false }),
  };
  const attachmentService = { uploadFile: jest.fn() };
  Object.assign(service, {
    pageRepo: {
      findById: jest
        .fn()
        .mockResolvedValue({
          id: pageId,
          workspaceId: 'ws-1',
          spaceId: 'sp-1',
        }),
    },
    pageAccessService,
    attachmentService,
    domainService: {
      getUrl: jest.fn().mockReturnValue('https://acme.akasha.test'),
    },
    environmentService: {
      getFileUploadSizeLimit: jest.fn().mockReturnValue('200mb'),
    },
    tokenService: {
      generateMcpUploadToken: jest.fn().mockResolvedValue('upload-token'),
    },
    ...overrides,
  });
  return { service, pageAccessService, attachmentService };
}

const ctx = { user, workspace } as any;

describe('upload_attachment instructions', () => {
  it('returns the file upload endpoint instead of accepting bytes', async () => {
    const { service, attachmentService } = subject();

    const result = await service.runTool(() =>
      service.uploadAttachment(ctx, { pageId }),
    );

    expect(result.isError).toBeUndefined();
    const body = decode(result);
    expect(body.uploadUrl).toBe('https://acme.akasha.test/api/files/upload');
    expect(body.method).toBe('POST');
    expect(body.contentType).toBe('multipart/form-data');
    expect(body.fields.pageId).toBe(pageId);
    expect(body.fields.attachmentId).toBeUndefined();
    expect(body.maxFileSize).toBe('200mb');
    expect(body.replaces).toBeNull();
    expect(attachmentService.uploadFile).not.toHaveBeenCalled();
  });

  it('keeps credentials out of the curl example', async () => {
    const { service } = subject();

    const body = decode(
      await service.runTool(() => service.uploadAttachment(ctx, { pageId })),
    );

    expect(body.curlExample).toContain('$AKASHA_MCP_UPLOAD_TOKEN');
    expect(body.curlExample).not.toContain('AKASHA_API_KEY');
    expect(body.curlExample).not.toContain('upload-token');
    expect(body.curlExample).toContain(`-F "pageId=${pageId}"`);
    expect(body.curlExample).toContain('-F "file=@<local-file-path>"');
  });

  it('issues a Page-scoped upload token instead of reusing the API key', async () => {
    const { service } = subject();

    const body = decode(
      await service.runTool(() => service.uploadAttachment(ctx, { pageId })),
    );

    expect(body.uploadToken).toBe('upload-token');
    expect(body.expiresInSeconds).toBe(600);
    expect(service.tokenService.generateMcpUploadToken).toHaveBeenCalledWith({
      userId: 'user-1',
      workspaceId: 'ws-1',
      pageId,
    });
  });

  it('carries the token value once, in uploadToken only', async () => {
    const { service } = subject();

    const result = await service.runTool(() =>
      service.uploadAttachment(ctx, { pageId }),
    );
    const body = decode(result);

    const occurrences = result.content[0].text.split('upload-token').length - 1;
    expect(occurrences).toBe(1);
    expect(body.auth).not.toContain('upload-token');
    expect(body.auth).toContain('<uploadToken>');
  });

  it('binds the upload token to the attachment being replaced', async () => {
    const { service } = subject();

    await service.runTool(() =>
      service.uploadAttachment(ctx, { pageId, attachmentId: 'att-9' }),
    );

    expect(service.tokenService.generateMcpUploadToken).toHaveBeenCalledWith({
      userId: 'user-1',
      workspaceId: 'ws-1',
      pageId,
      attachmentId: 'att-9',
    });
  });

  it('passes a replacement attachmentId through to the form fields', async () => {
    const { service } = subject();

    const body = decode(
      await service.runTool(() =>
        service.uploadAttachment(ctx, { pageId, attachmentId: 'att-9' }),
      ),
    );

    expect(body.fields.attachmentId).toBe('att-9');
    expect(body.replaces).toBe('att-9');
    expect(body.curlExample).toContain('-F "attachmentId=att-9"');
  });

  it('issues an attachment-scoped download token instead of reusing the API key', async () => {
    const attachmentId = '0b6f8a3e-5c1d-4e2a-9f47-1a2b3c4d5e09';
    const { service } = subject({
      attachmentRepo: {
        findById: jest.fn().mockResolvedValue({
          id: attachmentId,
          pageId,
          workspaceId: 'ws-1',
          fileName: 'report.pdf',
          mimeType: 'application/pdf',
          fileSize: 11,
        }),
      },
      pageAccessService: {
        validateCanView: jest.fn().mockResolvedValue(true),
      },
      tokenService: {
        generateMcpDownloadToken: jest.fn().mockResolvedValue('download-token'),
      },
    });

    const body = decode(
      await service.runTool(() =>
        service.downloadAttachment(ctx, { attachmentId }),
      ),
    );

    expect(body.downloadToken).toBe('download-token');
    expect(body.expiresInSeconds).toBe(600);
    expect(body.downloadUrl).toBe(
      `https://acme.akasha.test/api/files/${attachmentId}/report.pdf`,
    );
    expect(body.curlExample).toContain('$AKASHA_MCP_DOWNLOAD_TOKEN');
    expect(body.curlExample).not.toContain('AKASHA_API_KEY');
    expect(body.auth).not.toContain('download-token');
    expect(body.auth).toContain('<downloadToken>');
    expect(service.tokenService.generateMcpDownloadToken).toHaveBeenCalledWith({
      userId: 'user-1',
      workspaceId: 'ws-1',
      attachmentId,
    });
  });

  it('checks edit permission before handing out the upload URL', async () => {
    const { service, pageAccessService } = subject();
    pageAccessService.validateCanEdit.mockRejectedValue(
      new ForbiddenException(),
    );

    const result = await service.runTool(() =>
      service.uploadAttachment(ctx, { pageId }),
    );

    expect(result.isError).toBe(true);
    expect(decode(result).code).toBe('FORBIDDEN');
  });

  it('rejects a page from another workspace', async () => {
    const { service, pageAccessService } = subject({
      pageRepo: {
        findById: jest.fn().mockResolvedValue({
          id: pageId,
          workspaceId: 'ws-other',
          spaceId: 'sp-1',
        }),
      },
    });

    const result = await service.runTool(() =>
      service.uploadAttachment(ctx, { pageId }),
    );

    expect(result.isError).toBe(true);
    expect(decode(result).code).toBe('NOT_FOUND');
    expect(pageAccessService.validateCanEdit).not.toHaveBeenCalled();
  });

  it('checks the caller edit permission for every identity', async () => {
    const { service, pageAccessService } = subject();

    await service.runTool(() => service.uploadAttachment(ctx, { pageId }));

    expect(pageAccessService.validateCanEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: pageId }),
      user,
    );
  });
});
