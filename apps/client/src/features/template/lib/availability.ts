import { TemplateAvailability } from "../api/template.types";

export const ALL_SPACES: TemplateAvailability = {
  allSpaces: true,
  spaceIds: [],
};

/** 选了"指定空间"却一个都没选（且没有用户看不到的已指定空间）。 */
export function isAvailabilityEmpty(
  value: TemplateAvailability,
  otherSpaceCount = 0,
): boolean {
  return (
    !value.allSpaces && value.spaceIds.length === 0 && otherSpaceCount === 0
  );
}
