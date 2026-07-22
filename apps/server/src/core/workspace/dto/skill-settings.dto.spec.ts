import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateSkillSettingsDto } from './skill-settings.dto';

describe('UpdateSkillSettingsDto', () => {
  it('accepts a stable semantic version and HTTPS upgrade URL', async () => {
    const dto = plainToInstance(UpdateSkillSettingsDto, {
      latestVersion: '1.10.0',
      upgradeUrl: 'https://github.com/example/akasha-skill',
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it.each(['1.0', 'v1.0.0', '1.0.0-beta'])(
    'rejects unsupported version %s',
    async (version) => {
      const dto = plainToInstance(UpdateSkillSettingsDto, {
        latestVersion: version,
        upgradeUrl: 'https://github.com/example/akasha-skill',
      });

      const errors = await validate(dto);

      expect(errors.some((error) => error.property === 'latestVersion')).toBe(
        true,
      );
    },
  );

  it('rejects a non-HTTP upgrade URL', async () => {
    const dto = plainToInstance(UpdateSkillSettingsDto, {
      latestVersion: '1.0.0',
      upgradeUrl: 'ftp://example.com/akasha-skill',
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'upgradeUrl')).toBe(true);
  });
});
