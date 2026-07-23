import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('personal space owner migration', () => {
  const migrationPath = join(
    __dirname,
    'migrations',
    '20260722T100000-personal-space-owner.ts',
  );

  it('persists, backfills, and uniquely constrains personal space ownership', () => {
    const source = readFileSync(migrationPath, 'utf8');

    expect(source).toContain("addColumn('personal_owner_id', 'uuid'");
    expect(source).toContain("addUniqueConstraint('users_id_workspace_unique'");
    expect(source).toContain("'spaces_personal_owner_workspace_fk'");
    expect(source).toContain("['personal_owner_id', 'workspace_id']");
    expect(source).toContain(
      "addUniqueConstraint('spaces_workspace_personal_owner_unique'",
    );
    expect(source).toContain('ROW_NUMBER() OVER');
    expect(source).toContain('s.name = u.email');
    expect(source).toContain('INSERT INTO spaces');
    expect(source).toContain('personal_owner_id');
    expect(source).toContain('INSERT INTO space_members');
    expect(source).toContain("role = 'admin'");
  });

  it('repairs legacy personal spaces after a user name change', () => {
    const repairMigrationPath = join(
      __dirname,
      'migrations',
      '20260722T110000-personal-space-owner-repair.ts',
    );
    const source = readFileSync(repairMigrationPath, 'utf8');

    expect(source).toContain("CONCAT('(', u.email, ')')");
    expect(source).toContain('released_generated_spaces');
    expect(source).toContain('SET personal_owner_id = candidate.user_id');
  });
});
