import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/** 导航到页面时带上这个 state，页面会以编辑模式打开一次（如用模板新建的页面）。 */
export const OPEN_IN_EDIT_MODE_STATE = { openInEditMode: true } as const;

/**
 * 读取导航 state 里的 openInEditMode，并立刻从历史记录里清掉：
 * 刷新、后退再回来都按默认的阅读模式打开。
 * 只对导航时指定的那个页面生效（pageId 变了就失效）。
 */
export function useOpenInEditModeOnce(pageId: string | undefined): boolean {
  const location = useLocation();
  const navigate = useNavigate();
  const requested = (location.state as { openInEditMode?: boolean } | null)?.openInEditMode === true;
  // 记住是哪个页面请求的，state 清掉后仍保持到该页面卸载
  const [forPageId, setForPageId] = useState<string | null>(null);

  useEffect(() => {
    if (!requested || !pageId) return;
    setForPageId(pageId);
    navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: null },
    );
  }, [requested, pageId, navigate, location.pathname, location.search, location.hash]);

  return !!pageId && (requested || forPageId === pageId);
}
