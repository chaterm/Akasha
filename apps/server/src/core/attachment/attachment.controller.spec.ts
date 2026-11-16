import { NotFoundException } from '@nestjs/common';
import { AttachmentController } from './attachment.controller';

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
  it('validates page edit permission for a regular credential', async () => {
    const { controller, pageAccessService, agentAccessService } = subject();

    await controller.uploadFile(request(), reply(), user, workspace);

    expect(pageAccessService.validateCanEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: pageId }),
      user,
    );
    expect(agentAccessService.assertPageWritable).not.toHaveBeenCalled();
  });

  it('applies the agent space-binding check for an agent API key', async () => {
    const { controller, pageAccessService, agentAccessService } = subject();
    const agentAccess = { apiKeyId: 'key-1' } as any;

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
});
