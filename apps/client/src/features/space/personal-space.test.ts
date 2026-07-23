import { describe, expect, it } from "vitest";
import {
  findPersonalSpaceById,
  isPersonalSpace,
  isPersonalSpaceOwner,
} from "./personal-space";

describe("personal space helpers", () => {
  const personalSpace = { personalOwnerId: "user-1" };

  it("identifies personal spaces from their explicit owner", () => {
    expect(isPersonalSpace(personalSpace)).toBe(true);
    expect(isPersonalSpace({ personalOwnerId: null })).toBe(false);
  });

  it("identifies only the protected personal-space owner", () => {
    expect(isPersonalSpaceOwner(personalSpace, "user-1")).toBe(true);
    expect(isPersonalSpaceOwner(personalSpace, "user-2")).toBe(false);
  });

  it("resolves the current user personal space only by its stable id", () => {
    const spaces = [
      { id: "space-named-like-user", name: "Alice" },
      { id: "personal-1", name: "Renamed personal space" },
    ];

    expect(findPersonalSpaceById(spaces, "personal-1")).toBe(spaces[1]);
    expect(findPersonalSpaceById(spaces, null)).toBeUndefined();
  });
});
