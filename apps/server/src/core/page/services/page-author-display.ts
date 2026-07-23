type PageAuthor = {
  id: string;
  name: string | null;
  avatarUrl: string | null;
};

type PageWithAuthorDisplay = {
  creator?: PageAuthor | null;
  lastUpdatedBy?: PageAuthor | null;
  sourceCreatorName?: string | null;
  sourceLastUpdatedByName?: string | null;
};

function normalizeSourceName(name: string | null | undefined) {
  const normalized = name?.trim();
  return normalized || null;
}

function applyNameOverride(
  author: PageAuthor | null | undefined,
  sourceName: string | null | undefined,
) {
  const normalizedName = normalizeSourceName(sourceName);
  if (!author || !normalizedName) {
    return author;
  }

  return {
    ...author,
    name: normalizedName,
    avatarUrl: null,
  };
}

export function resolvePageAuthorDisplay<T extends PageWithAuthorDisplay>(
  page: T,
): T {
  const creator = applyNameOverride(page.creator, page.sourceCreatorName);
  const lastUpdatedBy = applyNameOverride(
    page.lastUpdatedBy,
    page.sourceLastUpdatedByName,
  );

  if (creator === page.creator && lastUpdatedBy === page.lastUpdatedBy) {
    return page;
  }

  return {
    ...page,
    creator,
    lastUpdatedBy,
  };
}
