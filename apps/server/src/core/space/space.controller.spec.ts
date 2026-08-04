import { Test, TestingModule } from '@nestjs/testing';
import { SpaceMemberRepo } from '@akasha/db/repos/space/space-member.repo';
import { SpaceRepo } from '@akasha/db/repos/space/space.repo';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import { SpaceController } from './space.controller';
import { SpaceMemberService } from './services/space-member.service';
import { SpaceService } from './services/space.service';

describe('SpaceController', () => {
  let controller: SpaceController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SpaceController],
      providers: [
        SpaceService,
        SpaceMemberService,
        SpaceMemberRepo,
        SpaceRepo,
        SpaceAbilityFactory,
        WorkspaceAbilityFactory,
      ].map((provide) => ({ provide, useValue: {} })),
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<SpaceController>(SpaceController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
