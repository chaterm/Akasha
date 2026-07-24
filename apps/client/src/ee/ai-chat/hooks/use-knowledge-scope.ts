import { useMemo, useState } from "react";
import { useGetSpacesQuery } from "@/features/space/queries/space-query";

export function useKnowledgeScope() {
  const spacesQuery = useGetSpacesQuery({ limit: 100 });
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  const options = useMemo(
    () =>
      (spacesQuery.data?.items ?? []).map((space) => ({
        value: space.id,
        label: space.name,
      })),
    [spacesQuery.data?.items],
  );
  const availableSpaceIds = useMemo(
    () => new Set(options.map((option) => option.value)),
    [options],
  );
  const normalizedSelectedSpaceId =
    spacesQuery.data &&
    selectedSpaceId &&
    !availableSpaceIds.has(selectedSpaceId)
      ? null
      : selectedSpaceId;

  return {
    options,
    selectedSpaceId: normalizedSelectedSpaceId,
    setSelectedSpaceId,
    spaceIds: normalizedSelectedSpaceId
      ? [normalizedSelectedSpaceId]
      : undefined,
    isLoading: spacesQuery.isLoading,
  };
}
