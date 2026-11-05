import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useEffect } from "react";
import { usePageQuery } from "@/features/page/queries/page-query";
import { buildPageUrl } from "@/features/page/page.utils.ts";
import { extractPageSlugId } from "@/lib";
import { Error404 } from "@/components/ui/error-404.tsx";

export default function PageRedirect() {
  const { pageSlug } = useParams();
  const {
    data: page,
    isLoading: pageIsLoading,
    isError,
  } = usePageQuery({ pageId: extractPageSlugId(pageSlug) });
  const navigate = useNavigate();
  const { search, hash } = useLocation();

  useEffect(() => {
    if (page) {
      const pageUrl = buildPageUrl(page.space.slug, page.slugId, page.title);
      navigate(`${pageUrl}${search}${hash}`);
    }
  }, [page]);

  if (isError) {
    return <Error404 />;
  }

  if (pageIsLoading) {
    return <></>;
  }

  return null;
}
