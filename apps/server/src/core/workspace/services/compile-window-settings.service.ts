import { Inject, Injectable } from '@nestjs/common';
import { KnowledgeCompileWindowRepo } from '@akasha/db/repos/llm-wiki/knowledge-compile-window.repo';
import {
  KnowledgeCompileWindowConfig,
  serverTimezone,
} from '@akasha/db/types/knowledge-compile-window.types';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import { UpdateCompileWindowSettingsDto } from '../dto/compile-window-settings.dto';

/** Responses carry the server timezone so the UI can name the clock used. */
export type CompileWindowSettingsResponse = KnowledgeCompileWindowConfig & {
  serverTimezone: string;
};

/** Admin settings for the knowledge night compile window. */
@Injectable()
export class CompileWindowSettingsService {
  constructor(
    private readonly compileWindowRepo: KnowledgeCompileWindowRepo,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async get(workspaceId: string): Promise<CompileWindowSettingsResponse> {
    const config = await this.compileWindowRepo.getConfig(workspaceId);
    return { ...config, serverTimezone: serverTimezone() };
  }

  async update(
    workspaceId: string,
    dto: UpdateCompileWindowSettingsDto,
  ): Promise<CompileWindowSettingsResponse> {
    const previous = await this.compileWindowRepo.getConfig(workspaceId);
    const next: KnowledgeCompileWindowConfig = {
      enabled: dto.enabled,
      startTime: dto.startTime,
      endTime: dto.endTime,
    };
    await this.compileWindowRepo.saveConfig(workspaceId, next);

    if (
      previous.enabled !== next.enabled ||
      previous.startTime !== next.startTime ||
      previous.endTime !== next.endTime
    ) {
      this.auditService.log({
        event: AuditEvent.WORKSPACE_UPDATED,
        resourceType: AuditResource.WORKSPACE,
        resourceId: workspaceId,
        changes: {
          before: { compileWindow: previous },
          after: { compileWindow: next },
        },
      });
    }
    return { ...next, serverTimezone: serverTimezone() };
  }
}
