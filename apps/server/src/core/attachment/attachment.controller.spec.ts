import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AttachmentController } from './attachment.controller';
import { JwtType } from '../auth/dto/jwt-payload';

const pageId = '0b6f8a3e-5c1d-4e2a-9f47-1a2b3c4d5e01';
const user = { id: 'user-1', workspaceId: 'ws-1' } as any;
const workspace = { id: 'ws-1', hostname: 'acme' } as any;

function subject(page: Record<string, any> | null = null) {
  const controller = Object.create(
    AttachmentController.prototype,
  ) as AttachmentController;
  const pageAccessService = {
    validateCanEdit: jest.fn().mockResolvedValue({ hasRestriction: false }),
  };
  const agentAccessService = {
    assertPageWritable: jest.fn().mockResolvedValue({ hasRestriction: false }),
  };
  const attachmentService = {
    uploadFile: jest.fn().mockResolvedValue({
      id: 'att-1',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      fileSize: 11,
    }),
  };
  Object.assign(controller, {
    logger: { error: jest.fn(), warn: jest.fn() },
    pageRepo: {
      findById: jest
        .fn()
        .mockResolvedValue(
          page ?? { id: pageId, workspaceId: 'ws-1', spaceId: 'sp-1' },
        ),
    },
    pageAccessService,
    agentAccessService,
    attachmentService,
    environmentService: {
      getFileUploadSizeLimit: jest.fn().mockReturnValue('200mb'),
    },
    domainService: { getUrl: jest.fn().mockReturnValue('https://acme.test') },
    auditService: { log: jest.fn() },
  });
  return {
    controller,
    pageAccessService,
    agentAccessService,
    attachmentService,
  };
}

function request() {
  return {
    file: jest.fn().mockResolvedValue({
      filename: 'report.pdf',
      fields: { pageId: { value: pageId } },
    }),
  } as any;
}

const reply = () => ({ send: jest.fn((value) => value) }) as any;

describe('AttachmentController.uploadFile', () => {
  it('validates page edit permission without an agent key', async () => {
    const { controller, pageAccessService, agentAccessService } = subject();

    await controller.uploadFile(request(), reply(), user, workspace);

    expect(pageAccessService.validateCanEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: pageId }),
      user,
    );
    expect(agentAccessService.assertPageWritable).not.toHaveBeenCalled();
  });

  it('narrows the write to the key scope when one is attached', async () => {
    const { controller, pageAccessService, agentAccessService } = subject();
    const agentAccess = { apiKeyId: 'key-1', spaceIds: ['sp-1'] } as any;

    await controller.uploadFile(
      request(),
      reply(),
      user,
      workspace,
      agentAccess,
    );

    expect(agentAccessService.assertPageWritable).toHaveBeenCalledWith(
      agentAccess,
      expect.objectContaining({ id: pageId }),
      user,
    );
    expect(pageAccessService.validateCanEdit).not.toHaveBeenCalled();
  });

  it('rejects a page that belongs to another workspace', async () => {
    const { controller, attachmentService } = subject({
      id: pageId,
      workspaceId: 'ws-other',
      spaceId: 'sp-1',
    });

    await expect(
      controller.uploadFile(request(), reply(), user, workspace),
    ).rejects.toThrow(NotFoundException);
    expect(attachmentService.uploadFile).not.toHaveBeenCalled();
  });

  it('accepts an MCP upload token scoped to this Page', async () => {
    const { controller, attachmentService } = subject();
    const companion = {
      type: JwtType.MCP_UPLOAD,
      userId: 'user-1',
      workspaceId: 'ws-1',
      pageId,
    } as any;

    await controller.uploadFile(
      request(),
      reply(),
      user,
      workspace,
      undefined,
      companion,
    );

    expect(attachmentService.uploadFile).toHaveBeenCalled();
  });

  it('rejects an MCP upload token minted for another Page', async () => {
    const { controller, attachmentService } = subject();
    const companion = {
      type: JwtType.MCP_UPLOAD,
      userId: 'user-1',
      workspaceId: 'ws-1',
      pageId: '11111111-2222-3333-4444-555555555555',
    } as any;

    await expect(
      controller.uploadFile(
        request(),
        reply(),
        user,
        workspace,
        undefined,
        companion,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(attachmentService.uploadFile).not.toHaveBeenCalled();
  });

  it('rejects an MCP upload token that does not cover the replaced attachment', async () => {
    const { controller, attachmentService } = subject();
    const req = {
      file: jest.fn().mockResolvedValue({
        filename: 'report.pdf',
        fields: {
          pageId: { value: pageId },
          attachmentId: { value: '0b6f8a3e-5c1d-4e2a-9f47-1a2b3c4d5e22' },
        },
      }),
    } as any;
    const companion = {
      type: JwtType.MCP_UPLOAD,
      userId: 'user-1',
      workspaceId: 'ws-1',
      pageId,
    } as any;

    await expect(
      controller.uploadFile(req, reply(), user, workspace, undefined, companion),
    ).rejects.toThrow(ForbiddenException);
    expect(attachmentService.uploadFile).not.toHaveBeenCalled();
  });
});

describe('AttachmentController.getFile', () => {
  const attachmentId = '0b6f8a3e-5c1d-4e2a-9f47-1a2b3c4d5e09';

  const downloadSubject = () => {
    const controller = Object.create(
      AttachmentController.prototype,
    ) as AttachmentController;
    const sendFileResponse = jest.fn().mockResolvedValue('sent');
    Object.assign(controller, {
      logger: { error: jest.fn(), warn: jest.fn() },
      attachmentRepo: {
        findById: jest.fn().mockResolvedValue({
          id: attachmentId,
          workspaceId: 'ws-1',
          pageId,
          spaceId: 'sp-1',
          aiChatId: null,
        }),
      },
      pageRepo: {
        findById: jest.fn().mockResolvedValue({ id: pageId }),
      },
      pageAccessService: { validateCanView: jest.fn().mockResolvedValue(true) },
      sendFileResponse,
    });
    return { controller, sendFileResponse };
  };

  it('accepts an MCP download token scoped to this file', async () => {
    const { controller, sendFileResponse } = downloadSubject();
    const companion = {
      type: JwtType.MCP_DOWNLOAD,
      userId: 'user-1',
      workspaceId: 'ws-1',
      attachmentId,
    } as any;

    await controller.getFile(
      {} as any,
      reply(),
      user,
      workspace,
      attachmentId,
      'report.pdf',
      companion,
    );

    expect(sendFileResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ id: attachmentId }),
      'private',
    );
  });

  it('rejects an MCP download token minted for another file', async () => {
    const { controller, sendFileResponse } = downloadSubject();
    const companion = {
      type: JwtType.MCP_DOWNLOAD,
      userId: 'user-1',
      workspaceId: 'ws-1',
      attachmentId: '77777777-6666-5555-4444-333333333333',
    } as any;

    await expect(
      controller.getFile(
        {} as any,
        reply(),
        user,
        workspace,
        attachmentId,
        'report.pdf',
        companion,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(sendFileResponse).not.toHaveBeenCalled();
  });
});
