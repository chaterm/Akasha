jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class CollaborationGateway {},
}));

import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AGENT_CAPABILITY } from '../decorators/agent-callable.decorator';
import { USER_IDENTITY_REQUIRED } from '../decorators/user-identity-required.decorator';
import { AttachmentController } from '../../core/attachment/attachment.controller';
import { GroupController } from '../../core/group/group.controller';
import { PageController } from '../../core/page/page.controller';
import { SpaceController } from '../../core/space/space.controller';
import { IselfAgentSpaceController } from '../../features/api-key/iself-agent-space.controller';
import { IsElfLlmWikiController } from '../../features/llm-wiki/iself-llm-wiki.controller';
import { LlmWikiController } from '../../features/llm-wiki/llm-wiki.controller';

const CONTROLLERS = [
  AttachmentController,
  GroupController,
  PageController,
  SpaceController,
  IselfAgentSpaceController,
  IsElfLlmWikiController,
  LlmWikiController,
];

const METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
};

function collect() {
  const routes: { route: string; capability: string; identity: boolean }[] = [];

  for (const controller of CONTROLLERS) {
    const basePath = Reflect.getMetadata(PATH_METADATA, controller) ?? '';
    const prototype = controller.prototype;

    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      const handler = prototype[name];
      if (typeof handler !== 'function') continue;

      const capability = Reflect.getMetadata(AGENT_CAPABILITY, handler);
      if (!capability) continue;

      const methodPath = Reflect.getMetadata(PATH_METADATA, handler) ?? '';
      const verb = Reflect.getMetadata(METHOD_METADATA, handler);
      const path = `/${basePath}/${methodPath}`.replace(/\/+/g, '/');
      routes.push({
        route: `${METHOD_NAMES[verb] ?? verb} ${path.replace(/\/$/, '') || '/'}`,
        capability,
        identity: Boolean(Reflect.getMetadata(USER_IDENTITY_REQUIRED, handler)),
      });
    }
  }

  return routes.sort((a, b) => a.route.localeCompare(b.route));
}

describe('Agent-callable endpoint whitelist', () => {
  it('matches the documented set', () => {
    expect(collect()).toEqual([
      {
        route: 'GET /files/:fileId/:fileName',
        capability: 'attachment.read',
        identity: false,
      },
      {
        route: 'POST /files/info',
        capability: 'attachment.read',
        identity: false,
      },
      {
        route: 'POST /files/upload',
        capability: 'attachment.upload',
        identity: false,
      },
      {
        route: 'POST /groups/members',
        capability: 'group.member.read',
        identity: false,
      },
      {
        route: 'POST /iself/llm-wiki/query',
        capability: 'knowledge.query',
        identity: false,
      },
      { route: 'POST /iself/space', capability: 'space.read', identity: false },
      {
        route: 'POST /iself/space-api-key/update',
        capability: 'space.binding.update',
        identity: true,
      },
      {
        route: 'POST /llm-wiki/citation-page',
        capability: 'page.read',
        identity: false,
      },
      {
        route: 'POST /llm-wiki/query',
        capability: 'knowledge.query',
        identity: false,
      },
      {
        route: 'POST /pages/attachments',
        capability: 'attachment.read',
        identity: false,
      },
      {
        route: 'POST /pages/create',
        capability: 'page.create',
        identity: false,
      },
      { route: 'POST /pages/info', capability: 'page.read', identity: false },
      {
        route: 'POST /pages/permission-info',
        capability: 'page.permission.read',
        identity: false,
      },
      {
        route: 'POST /pages/permissions',
        capability: 'page.permission.read',
        identity: false,
      },
      { route: 'POST /pages/search', capability: 'page.read', identity: false },
      {
        route: 'POST /pages/sidebar-pages',
        capability: 'page.tree.read',
        identity: false,
      },
      {
        route: 'POST /pages/update',
        capability: 'page.content.update',
        identity: false,
      },
      { route: 'POST /spaces', capability: 'space.read', identity: false },
      { route: 'POST /spaces/info', capability: 'space.read', identity: false },
      {
        route: 'POST /spaces/members',
        capability: 'space.member.read',
        identity: false,
      },
    ]);
  });
});
