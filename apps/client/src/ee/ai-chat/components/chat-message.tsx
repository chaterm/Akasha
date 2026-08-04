import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import DOMPurify from "dompurify";
import {
  IconFile,
  IconLoader2,
  IconPhoto,
  IconDatabaseSearch,
  IconChevronRight,
  IconExternalLink,
  IconPencil,
} from "@tabler/icons-react";
import { markdownToHtml } from "@docmost/editor-ext";
import type {
  AiChatMessage,
  AiChatToolCall,
  AiQaCitation,
  AiQaCitationEvidence,
  AiQaProgressStage,
  AiQaRetrievalDiagnostics,
} from "../types/ai-chat.types";
import ChatToolGroup from "./chat-tool-group";
import classes from "../styles/chat-message.module.css";
import CopyTextButton from "@/components/common/copy.tsx";

const DIRECT_PAGE_HREF_RE =
  /^\/(?:s\/[^/?#\s]+\/p\/[^/?#\s]+|p\/[^/?#\s]+)(?:[?#][^\s]*)?$/;

function normalizeInternalPageHref(href: string): string | null {
  if (DIRECT_PAGE_HREF_RE.test(href)) return href;

  // Models occasionally wrap an internal path in a fabricated host. Recover
  // the app-local route without dropping a query string or section anchor.
  if (/^(?:https?:)?\/\//i.test(href)) {
    try {
      const url = new URL(href, "https://akasha.invalid");
      const path = `${url.pathname}${url.search}${url.hash}`;
      if (DIRECT_PAGE_HREF_RE.test(path)) return path;
    } catch {
      return null;
    }

    // Also recover the common malformed form `https://s/{slug}/p/{page}`,
    // where `s` was interpreted as a host instead of the first path segment.
    const hostless = `/${href.replace(/^(?:https?:)?\/\//i, "")}`;
    if (DIRECT_PAGE_HREF_RE.test(hostless)) return hostless;
  }

  return null;
}

const chatSanitizer = DOMPurify();
chatSanitizer.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName !== "A") return;
  const href = node.getAttribute("href") || "";

  const internalPageHref = normalizeInternalPageHref(href);
  if (internalPageHref) {
    node.setAttribute("href", internalPageHref);
    node.removeAttribute("target");
    node.removeAttribute("rel");
    return;
  }

  if (href.startsWith("http://") || href.startsWith("https://")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];

type Props = {
  message: AiChatMessage;
  isStreaming?: boolean;
  streamingContent?: string;
  streamingToolCalls?: AiChatToolCall[];
  progressStage?: AiQaProgressStage | null;
  onEdit?: (messageId: string, content: string) => void;
  editDisabled?: boolean;
  onEditingChange?: (editing: boolean) => void;
};

export default function ChatMessage({
  message,
  isStreaming,
  streamingContent,
  streamingToolCalls,
  progressStage,
  onEdit,
  editDisabled = false,
  onEditingChange,
}: Props) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content || "");

  useEffect(() => {
    if (!isEditing) setEditContent(message.content || "");
  }, [isEditing, message.content]);

  const closeEditor = useCallback(() => {
    setIsEditing(false);
    setEditContent(message.content || "");
    onEditingChange?.(false);
  }, [message.content, onEditingChange]);

  const startEditing = useCallback(() => {
    setEditContent(message.content || "");
    setIsEditing(true);
    onEditingChange?.(true);
  }, [message.content, onEditingChange]);

  const saveEdit = useCallback(() => {
    const nextContent = editContent.trim();
    if (!nextContent) return;
    onEdit?.(message.id, nextContent);
    closeEditor();
  }, [closeEditor, editContent, message.id, onEdit]);

  const handleContentClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a");
      if (!anchor) return;

      const href = anchor.getAttribute("href");
      if (href && (href.startsWith("/s/") || href.startsWith("/p/"))) {
        e.preventDefault();
        navigate(href);
      }
    },
    [navigate],
  );

  if (message.role === "tool") return null;

  const isUser = message.role === "user";
  const content = isStreaming ? streamingContent : message.content;
  const toolCalls = isStreaming ? streamingToolCalls : message.toolCalls;
  const qaMetadata = readQaMetadata(message.metadata);

  if (isUser) {
    const displayContent = (content || "").replace(
      /\n\n<referenced_pages>[\s\S]*<\/referenced_pages>$/,
      "",
    );
    const attachments =
      (message.metadata?.attachments as {
        id: string;
        fileName: string;
        fileExt: string;
      }[]) || [];

    return (
      <div
        className={classes.userMessage}
        role="article"
        aria-label={t("You said:")}
        data-editing={isEditing || undefined}
      >
        <div className={classes.userMessageBody}>
          <div className={classes.userBubble}>
            {attachments.length > 0 && (
              <div className={classes.messageAttachments}>
                {attachments.map((a) => (
                  <span key={a.id} className={classes.messageAttachmentChip}>
                    {IMAGE_EXTENSIONS.includes(a.fileExt) ? (
                      <IconPhoto size={13} />
                    ) : (
                      <IconFile size={13} />
                    )}
                    {a.fileName}
                  </span>
                ))}
              </div>
            )}
            {isEditing ? (
              <div className={classes.editMessageForm}>
                <textarea
                  aria-label={t("Edit message")}
                  className={classes.editMessageTextarea}
                  value={editContent}
                  maxLength={4000}
                  rows={Math.min(
                    8,
                    Math.max(2, editContent.split("\n").length),
                  )}
                  autoFocus
                  onChange={(event) =>
                    setEditContent(event.currentTarget.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      closeEditor();
                    } else if (
                      event.key === "Enter" &&
                      (event.metaKey || event.ctrlKey)
                    ) {
                      event.preventDefault();
                      saveEdit();
                    }
                  }}
                />
                <div className={classes.editMessageActions}>
                  <button type="button" onClick={closeEditor}>
                    {t("Cancel")}
                  </button>
                  <button
                    type="button"
                    className={classes.editMessageSave}
                    disabled={!editContent.trim()}
                    onClick={saveEdit}
                  >
                    {t("Save and regenerate")}
                  </button>
                </div>
              </div>
            ) : (
              displayContent
            )}
          </div>
          {onEdit && !isEditing && (
            <button
              type="button"
              aria-label={t("Edit message")}
              title={t("Edit message")}
              className={classes.editMessageButton}
              disabled={editDisabled}
              onClick={startEditing}
            >
              <IconPencil size={15} stroke={1.8} />
            </button>
          )}
        </div>
      </div>
    );
  }

  // Only label the article when there's something meaningful to announce.
  // Tool-only assistant turns (no text) shouldn't announce "Assistant said:" with empty content.
  const hasAnnouncableContent = Boolean(content);

  return (
    <div
      className={classes.assistantMessage}
      role="article"
      aria-label={hasAnnouncableContent ? t("Assistant said:") : undefined}
    >
      <div className={classes.messageContent}>
        {toolCalls && toolCalls.length > 0 && (
          <ChatToolGroup toolCalls={toolCalls} isStreaming={isStreaming} />
        )}
        {content && (
          <div className={classes.answerContent}>
            <div
              onClick={handleContentClick}
              dangerouslySetInnerHTML={{
                __html: chatSanitizer.sanitize(
                  markdownToHtml(content) as string,
                  { ADD_ATTR: ["target", "rel"] },
                ),
              }}
            />
            {!isStreaming && (
              <div className={classes.messageActions}>
                <CopyTextButton
                  text={message.content}
                  label={t("Copy assistant response")}
                />
              </div>
            )}
          </div>
        )}
        {isStreaming && (
          <>
            {!content && (
              <span className={classes.processingIndicator}>
                <IconLoader2 size={16} className={classes.processingSpinner} />
                {t(progressLabel(progressStage))}
              </span>
            )}
            <span className={classes.streamingCursor} />
          </>
        )}
        {!isStreaming &&
          !isUser &&
          qaMetadata.hasQaMetadata &&
          qaMetadata.answerMode !== "general" && (
            <KnowledgeEvidence
              citations={qaMetadata.citations}
              citationEvidence={qaMetadata.citationEvidence}
              diagnostics={qaMetadata.diagnostics}
              answerMode={qaMetadata.answerMode}
              retrievalQuery={qaMetadata.retrievalQuery}
            />
          )}
      </div>
    </div>
  );
}

function KnowledgeEvidence({
  citations,
  citationEvidence,
  diagnostics,
  answerMode,
  retrievalQuery,
}: {
  citations: AiQaCitation[];
  citationEvidence: AiQaCitationEvidence[];
  diagnostics?: AiQaRetrievalDiagnostics;
  answerMode?: "knowledge" | "no_match" | "general";
  retrievalQuery?: string;
}) {
  const { t } = useTranslation();
  const evidenceBySourceId = new Map(
    citationEvidence.map((evidence) => [evidence.sourcePageId, evidence]),
  );
  const isNoMatch = answerMode === "no_match";
  const hasCitations = citations.length > 0;

  return (
    <>
      <details className={classes.evidenceCard} data-answer-mode={answerMode}>
        <summary className={classes.evidenceHeader}>
          <IconDatabaseSearch size={16} />
          <span>
            {isNoMatch
              ? t("No matching knowledge found")
              : hasCitations
                ? t("Answer sources")
                : t("No verifiable citation was generated")}
          </span>
          {hasCitations && (
            <span className={classes.evidenceCount}>
              {citations.length === 1
                ? t("1 verifiable source")
                : t("{{count}} verifiable sources", {
                    count: citations.length,
                  })}
            </span>
          )}
          <IconChevronRight className={classes.evidenceChevron} size={15} />
        </summary>

        {retrievalQuery && (
          <details className={classes.retrievalDetails}>
            <summary>{t("Contextual retrieval query")}</summary>
            <p className={classes.retrievalQueryText}>{retrievalQuery}</p>
          </details>
        )}

        {hasCitations && (
          <div className={classes.citationSources}>
            {citations.map((source) => {
              const evidence = evidenceBySourceId.get(source.sourcePageId);
              return (
                <div
                  key={source.sourcePageId}
                  className={classes.citationSource}
                >
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={classes.citationSourceLink}
                  >
                    <span>{source.title}</span>
                    <IconExternalLink size={13} />
                  </a>
                  {evidence?.excerpts.map((excerpt) => (
                    <blockquote
                      key={`${excerpt.quoteHash}:${excerpt.sourceRange.startOffset}:${excerpt.sourceRange.endOffset}`}
                      className={classes.citationExcerpt}
                    >
                      {excerpt.text}
                    </blockquote>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {diagnostics && (
          <details className={classes.retrievalDetails}>
            <summary>{t("Retrieval details")}</summary>
            <dl className={classes.retrievalDiagnostics}>
              <div>
                <dt>{t("Candidate sources")}</dt>
                <dd>{diagnostics.candidateSourceCount}</dd>
              </div>
              <div>
                <dt>{t("Knowledge chunks used")}</dt>
                <dd>{diagnostics.authorizedChunkCount}</dd>
              </div>
              <div>
                <dt>{t("Verifiable citations")}</dt>
                <dd>{citations.length}</dd>
              </div>
              <div>
                <dt>{t("Retrieval mode")}</dt>
                <dd>
                  {diagnostics.queryEmbeddingAvailable
                    ? t("Semantic + keyword retrieval")
                    : t("Keyword retrieval fallback")}
                </dd>
              </div>
            </dl>
            {diagnostics.queryEmbeddingAvailable === false && (
              <div className={classes.retrievalWarning}>
                {t(
                  "Semantic retrieval was unavailable; keyword retrieval was used.",
                )}
              </div>
            )}
          </details>
        )}
      </details>
    </>
  );
}

function readQaMetadata(metadata: Record<string, unknown> | null) {
  const citations = readCitations(metadata?.citations);
  const citationEvidence = readCitationEvidence(metadata?.citationEvidence);
  const diagnostics = isRecord(metadata?.retrievalDiagnostics)
    ? (metadata?.retrievalDiagnostics as AiQaRetrievalDiagnostics)
    : undefined;
  const answerMode: "knowledge" | "no_match" | "general" | undefined =
    metadata?.answerMode === "knowledge" ||
    metadata?.answerMode === "no_match" ||
    metadata?.answerMode === "general"
      ? metadata.answerMode
      : undefined;
  const retrievalQuery =
    typeof metadata?.retrievalQuery === "string" &&
    metadata.retrievalQuery.trim()
      ? metadata.retrievalQuery.trim()
      : undefined;

  return {
    citations,
    citationEvidence,
    diagnostics,
    answerMode,
    retrievalQuery,
    hasQaMetadata: Boolean(
      answerMode ||
      retrievalQuery ||
      diagnostics ||
      citations.length ||
      citationEvidence.length,
    ),
  };
}

function readCitationEvidence(value: unknown): AiQaCitationEvidence[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    const url =
      isRecord(item) && typeof item.url === "string"
        ? normalizeInternalPageHref(item.url)
        : null;
    if (
      !isRecord(item) ||
      typeof item.sourcePageId !== "string" ||
      typeof item.title !== "string" ||
      typeof item.url !== "string" ||
      !url ||
      !Array.isArray(item.excerpts)
    ) {
      return [];
    }

    const excerpts = item.excerpts.filter(
      (excerpt): excerpt is AiQaCitationEvidence["excerpts"][number] =>
        isRecord(excerpt) &&
        typeof excerpt.text === "string" &&
        typeof excerpt.quoteHash === "string" &&
        isRecord(excerpt.sourceRange) &&
        typeof excerpt.sourceRange.startOffset === "number" &&
        typeof excerpt.sourceRange.endOffset === "number",
    );

    return [
      {
        sourcePageId: item.sourcePageId,
        title: item.title,
        url,
        excerpts,
      },
    ];
  });
}

function readCitations(value: unknown): AiQaCitation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.sourcePageId !== "string" ||
      typeof item.title !== "string" ||
      typeof item.url !== "string"
    ) {
      return [];
    }

    const url = normalizeInternalPageHref(item.url);
    return url
      ? [
          {
            sourcePageId: item.sourcePageId,
            title: item.title,
            url,
          },
        ]
      : [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function progressLabel(stage?: AiQaProgressStage | null): string {
  if (stage === "permissions") return "Checking knowledge access...";
  if (stage === "understanding") return "Understanding the conversation...";
  if (stage === "retrieval") return "Searching the knowledge base...";
  if (stage === "generation") return "Generating a grounded answer...";
  return "Preparing knowledge answer...";
}
