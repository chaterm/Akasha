import { readFileSync } from 'node:fs';

describe('WorkspaceInvitationService personal-space provisioning', () => {
  it('creates the invited user personal space in the invitation transaction', () => {
    const source = readFileSync(
      __dirname + '/workspace-invitation.service.ts',
      {
        encoding: 'utf8',
      },
    );

    expect(source).toContain(
      'await this.spaceService.ensurePersonalSpace(newUser, workspace.id, trx)',
    );
  });
});
