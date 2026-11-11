import slugify from "@sindresorhus/slugify";

const buildPageSlug = (pageSlugId: string, pageTitle?: string): string => {
  const titleSlug = slugify(pageTitle?.substring(0, 70) || "untitled", {
    customReplacements: [
      ["♥", ""],
      ["🦄", ""],
    ],
  });

  return `${titleSlug}-${pageSlugId}`;
};

function appendSearchParams(
  url: string,
  search?: string[],
  wholeWord?: boolean,
): string {
  if(search?.length === 0){
    return url;
  }

  const params = new URLSearchParams();
  search
    ?.map((term) => term.trim())
    .filter(Boolean)
    .forEach((term) => params.append("q", term));

  if (wholeWord) {
    params.set("m", "whole");
  }

  const queryString = params.toString();

  return queryString ? `${url}?${queryString}` : url;
}

export const buildPageUrl = (
  spaceName: string,
  pageSlugId: string,
  pageTitle?: string,
  anchorId?: string,
  search?: string[],
  wholeWord?: boolean,
): string => {
  let url: string;
  if (spaceName === undefined) {
    url = `/p/${buildPageSlug(pageSlugId, pageTitle)}`;
  } else {
    url = `/s/${spaceName}/p/${buildPageSlug(pageSlugId, pageTitle)}`;
  }

  url = appendSearchParams(url, search, wholeWord);

  return anchorId ? `${url}#${anchorId}` : url;
};

export const buildSharedPageUrl = (opts: {
  shareId: string;
  pageSlugId: string;
  pageTitle?: string;
  anchorId?: string;
  search?: string[];
  wholeWord?: boolean;
}): string => {
  const { shareId, pageSlugId, pageTitle, anchorId, search, wholeWord } = opts;
  let url: string;
  if (!shareId) {
    url = `/share/p/${buildPageSlug(pageSlugId, pageTitle)}`;
  } else {
    url = `/share/${shareId}/p/${buildPageSlug(pageSlugId, pageTitle)}`;
  }

  url = appendSearchParams(url, search, wholeWord);

  return anchorId ? `${url}#${anchorId}` : url;
};
