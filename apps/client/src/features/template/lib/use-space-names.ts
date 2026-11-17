import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useGetSpacesQuery } from "@/features/space/queries/space-query";
import { ISpace } from "@/features/space/types/space.types";
import { PageTemplate } from "../api/template.types";

export function useSpaceDirectory() {
  const { t } = useTranslation();
  const { data } = useGetSpacesQuery({ limit: 100 });

  const { spaces, names } = useMemo(() => {
    const spaces: ISpace[] = data?.items ?? [];
    return { spaces, names: new Map(spaces.map((s) => [s.id, s.name])) };
  }, [data]);

  const availabilityLabel = useCallback(
    (tpl: Pick<PageTemplate, "allSpaces" | "spaceIds" | "otherSpaceCount">) => {
      if (tpl.allSpaces) return t("All spaces");
      const total = tpl.spaceIds.length + (tpl.otherSpaceCount ?? 0);
      const first = tpl.spaceIds[0] && names.get(tpl.spaceIds[0]);
      if (!first) return t("{{count}} spaces", { count: total });
      return total > 1
        ? t("{{name}} and {{count}} other spaces", {
            name: first,
            count: total - 1,
            total,
          })
        : first;
    },
    [names, t],
  );

  return { spaces, names, availabilityLabel };
}
