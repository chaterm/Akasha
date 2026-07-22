import { Kysely, RawBuilder } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { WorkspaceRepo } from './workspace.repo';

class FakeUpdateQuery {
  settingsExpression?: RawBuilder<unknown>;

  updateTable() {
    return this;
  }

  set(values: { settings: RawBuilder<unknown> }) {
    this.settingsExpression = values.settings;
    return this;
  }

  where() {
    return this;
  }

  returning() {
    return this;
  }

  async executeTakeFirst() {
    return undefined;
  }
}

describe('WorkspaceRepo Skill settings', () => {
  it('stores Skill settings as a JSON object instead of a JSON string', async () => {
    const query = new FakeUpdateQuery();
    const repo = new WorkspaceRepo(query as never);

    await repo.updateAiSkillSettings('workspace-1', {
      latestVersion: '1.0.0',
      upgradeUrl: 'https://github.com/chaterm/akasha/skills',
    });

    const compiler = new Kysely({
      dialect: new PostgresJSDialect({ postgres: {} as never }),
    });
    const compiled = query.settingsExpression.compile(compiler);

    expect(compiled.sql).toMatch(
      /jsonb_build_object\('skill',\s*jsonb_build_object\(\s*'latestVersion'/,
    );
    expect(compiled.sql).toMatch(/'latestVersion', \$1::text/);
    expect(compiled.sql).toMatch(/'upgradeUrl', \$2::text/);
    expect(compiled.parameters).not.toContain(
      '{"latestVersion":"1.0.0","upgradeUrl":"https://github.com/chaterm/akasha/skills"}',
    );
    expect(compiled.parameters).toEqual([
      '1.0.0',
      'https://github.com/chaterm/akasha/skills',
    ]);
  });
});
