import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import SpaceDetails from "./space-details";

const context = vi.hoisted(() => ({
  userId: "creator",
  isAdmin: false,
  isOwner: false,
  isDefaultPersonal: false,
}));

vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useAtomValue: () => ({ user: { id: context.userId } }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/use-user-role.tsx", () => ({
  default: () => ({ isAdmin: context.isAdmin, isOwner: context.isOwner }),
}));
vi.mock("@/features/space/queries/space-query.ts", () => ({
  useSpaceQuery: () => ({
    data: {
      id: "space-1",
      name: "Notes",
      creatorId: "creator",
      personalOwnerId: "creator",
      isDefaultPersonal: context.isDefaultPersonal,
    },
  }),
}));
vi.mock("@/features/space/components/edit-space-form.tsx", () => ({
  EditSpaceForm: () => null,
}));
vi.mock("@/features/space/components/space-knowledge-settings.tsx", () => ({
  default: () => null,
}));
vi.mock("./delete-space-modal", () => ({
  default: () => <button>Delete</button>,
}));
vi.mock("@/components/common/export-modal.tsx", () => ({
  default: () => null,
}));
vi.mock("@/components/common/avatar-uploader.tsx", () => ({
  default: () => null,
}));
vi.mock("@/features/attachments/services/attachment-service.ts", () => ({
  uploadSpaceIcon: vi.fn(),
  removeSpaceIcon: vi.fn(),
}));
vi.mock("@/main.tsx", () => ({ queryClient: {} }));

describe("personal space settings actions", () => {
  beforeAll(() => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  afterAll(() => vi.unstubAllGlobals());

  it.each([
    {
      userId: "creator",
      isAdmin: false,
      isDefaultPersonal: false,
      canDelete: true,
      canExport: true,
    },
    {
      userId: "admin",
      isAdmin: true,
      isDefaultPersonal: false,
      canDelete: true,
      canExport: true,
    },
    {
      userId: "creator",
      isAdmin: false,
      isDefaultPersonal: true,
      canDelete: false,
      canExport: true,
    },
    {
      userId: "admin",
      isAdmin: true,
      isDefaultPersonal: true,
      canDelete: false,
      canExport: true,
    },
    {
      userId: "other",
      isAdmin: false,
      isDefaultPersonal: false,
      canDelete: false,
      canExport: false,
    },
  ])(
    "shows the permitted actions for %j",
    ({ userId, isAdmin, isDefaultPersonal, canDelete, canExport }) => {
      Object.assign(context, { userId, isAdmin, isDefaultPersonal });
      render(
        <MantineProvider env="test">
          <SpaceDetails spaceId="space-1" canManageSettings />
        </MantineProvider>,
      );

      expect(Boolean(screen.queryByRole("button", { name: "Delete" }))).toBe(
        canDelete,
      );
      expect(Boolean(screen.queryByRole("button", { name: "Export" }))).toBe(
        canExport,
      );
    },
  );
});
