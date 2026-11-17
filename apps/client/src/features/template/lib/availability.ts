import { TemplateAvailability } from "../api/template.types";

export const ALL_SPACES: TemplateAvailability = {
  allSpaces: true,
  spaceIds: [],
};

export function isAvailabilityEmpty(
  value: TemplateAvailability,
  otherSpaceCount = 0,
): boolean {
  return (
    !value.allSpaces && value.spaceIds.length === 0 && otherSpaceCount === 0
  );
}
