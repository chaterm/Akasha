import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useSetAtom } from "jotai";
import { useCommentsQuery } from "@/features/comment/queries/comment-query";
import { asideStateAtom } from "@/components/layouts/global/hooks/atoms/sidebar-atom";
import {
  activeCommentIdAtom,
  commentPanelTabAtom,
} from "@/features/comment/atoms/comment-atom";
import classes from "@/features/comment/components/comment.module.css";

const COMMENT_ID_PARAM = "commentId";
const HIGHLIGHT_DURATION = 3000;
const RETRY_INTERVAL = 100;
const MAX_RETRIES = 40;

export function useCommentDeepLink(pageId: string | undefined) {
  const [searchParams, setSearchParams] = useSearchParams();
  const commentId = searchParams.get(COMMENT_ID_PARAM);

  const setAsideState = useSetAtom(asideStateAtom);
  const setActiveCommentId = useSetAtom(activeCommentIdAtom);
  const setCommentPanelTab = useSetAtom(commentPanelTabAtom);

  const { data: comments, isLoading } = useCommentsQuery({
    pageId: (commentId ? pageId : undefined) as string,
  });

  const handledRef = useRef<string | null>(null);
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  useEffect(
    () => () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    },
    [],
  );

  useEffect(() => {
    setCommentPanelTab("open");
  }, [pageId, setCommentPanelTab]);

  useEffect(() => {
    if (!commentId) {
      handledRef.current = null;
      return;
    }
    if (!pageId) return;
    if (isLoading || !comments?.items) return;
    if (handledRef.current === commentId) return;
    handledRef.current = commentId;

    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete(COMMENT_ID_PARAM);
    setSearchParams(nextParams, { replace: true });

    const target = comments.items.find((c) => c.id === commentId);
    if (!target) return;

    const threadId = target.parentCommentId ?? target.id;
    const thread = comments.items.find((c) => c.id === threadId);

    setCommentPanelTab(thread?.resolvedAt ? "resolved" : "open");
    setActiveCommentId(threadId);
    setAsideState({ tab: "comments", isAsideOpen: true });

    const onElementReady = (
      selector: string,
      onFound: (el: HTMLElement) => void,
    ) => {
      let attempts = 0;
      let lastTop: number | null = null;
      let stableTicks = 0;
      const tick = () => {
        let el: HTMLElement | null = null;
        try {
          el = document.querySelector<HTMLElement>(selector);
        } catch {
          return;
        }
        attempts += 1;
        const lastAttempt = attempts >= MAX_RETRIES;
        if (el) {
          const top = Math.round(
            el.getBoundingClientRect().top + window.scrollY,
          );
          stableTicks =
            lastTop !== null && Math.abs(top - lastTop) <= 1
              ? stableTicks + 1
              : 0;
          lastTop = top;
          if (stableTicks >= 2 || lastAttempt) {
            onFound(el);
            return;
          }
        }
        if (!lastAttempt) {
          timersRef.current.push(setTimeout(tick, RETRY_INTERVAL));
        }
      };
      tick();
    };

    onElementReady(`div[data-comment-id="${threadId}"]`, (el) => {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add(classes.deepLinkHighlight);
      timersRef.current.push(
        setTimeout(
          () => el.classList.remove(classes.deepLinkHighlight),
          HIGHLIGHT_DURATION,
        ),
      );
    });

    if (thread?.selection && !thread.resolvedAt) {
      onElementReady(`.comment-mark[data-comment-id="${threadId}"]`, (el) => {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("comment-highlight");
        timersRef.current.push(
          setTimeout(
            () => el.classList.remove("comment-highlight"),
            HIGHLIGHT_DURATION,
          ),
        );
      });
    }
  }, [
    commentId,
    pageId,
    isLoading,
    comments,
    searchParams,
    setSearchParams,
    setAsideState,
    setActiveCommentId,
    setCommentPanelTab,
  ]);
}
