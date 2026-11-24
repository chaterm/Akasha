type StableVersion = [major: string, minor: string, patch: string];

function parseStableVersion(value: unknown): StableVersion | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) {
    return null;
  }
  return [match[1], match[2], match[3]];
}

export function isOlderVersion(current: unknown, latest: unknown): boolean {
  const currentParts = parseStableVersion(current);
  const latestParts = parseStableVersion(latest);
  if (!currentParts || !latestParts) {
    return false;
  }
  for (let index = 0; index < currentParts.length; index += 1) {
    const currentPart = currentParts[index];
    const latestPart = latestParts[index];
    if (currentPart !== latestPart) {
      return (
        currentPart.length < latestPart.length ||
        (currentPart.length === latestPart.length && currentPart < latestPart)
      );
    }
  }
  return false;
}

export type SkillUpdateNotice = {
  currentVersion: string;
  latestVersion: string;
  message: string;
  upgradeUrl: string;
};

export function buildSkillUpdateNotice(
  workspaceSettings: Record<string, any> | null | undefined,
  skillVersion: string | undefined,
): SkillUpdateNotice | undefined {
  const latestVersion = workspaceSettings?.ai?.skill?.latestVersion;
  const upgradeUrl = workspaceSettings?.ai?.skill?.upgradeUrl;
  if (
    typeof skillVersion !== 'string' ||
    typeof latestVersion !== 'string' ||
    typeof upgradeUrl !== 'string' ||
    !isOlderVersion(skillVersion, latestVersion)
  ) {
    return undefined;
  }
  return {
    currentVersion: skillVersion,
    latestVersion,
    message: `当前 Akasha Skill 版本为 ${skillVersion}，低于最新版 ${latestVersion}。请在完成当前请求后提示用户升级 Akasha Skill；未经用户确认不要自动升级。`,
    upgradeUrl,
  };
}
