import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

export const OPEN_IN_EDIT_MODE_STATE = { openInEditMode: true } as const;

export function useOpenInEditModeOnce(pageId: string | undefined): boolean {
  const location = useLocation();
  const navigate = useNavigate();
  const requested =
    (location.state as { openInEditMode?: boolean } | null)?.openInEditMode ===
    true;
  const [forPageId, setForPageId] = useState<string | null>(null);

  useEffect(() => {
    if (!requested || !pageId) return;
    setForPageId(pageId);
    navigate(
      {
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
      },
      { replace: true, state: null },
    );
  }, [
    requested,
    pageId,
    navigate,
    location.pathname,
    location.search,
    location.hash,
  ]);

  return !!pageId && (requested || forPageId === pageId);
}
