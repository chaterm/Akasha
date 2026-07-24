import { useCallback } from "react";
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

const PAGE_PATH_RE = /\/s\/[^/?#]+\/p\/[^/?#]+/;

const chatSanitizer = DOMPurify();
chatSanitizer.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName !== "A") return;
  const href = node.getAttribute("href") || "";

  // Recover the canonical /s/{slug}/p/{slugId} path if the model wrapped it
  // in a fabricated host (https://s/..., https://yoursite.com/s/..., //s/...).
  const m = href.match(PAGE_PATH_RE);
  if (m) {
    node.setAttribute("href", m[0]);
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
};

export default function ChatMessage({
  message,
  isStreaming,
  streamingContent,
  streamingToolCalls,
  progressStage,
}: Props) {
  const navigate = useNavigate();
  const { t } = useTranslation();

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
      >
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
          {displayContent}
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
          <div
            onClick={handleContentClick}
            dangerouslySetInnerHTML={{
              __html: chatSanitizer.sanitize(
                markdownToHtml(content) as string,
                { ADD_ATTR: ["target", "rel"] },
              ),
            }}
          />
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
        {!isStreaming && !isUser && qaMetadata.hasQaMetadata && (
          <KnowledgeEvidence
            citations={qaMetadata.citations}
            citationEvidence={qaMetadata.citationEvidence}
            diagnostics={qaMetadata.diagnostics}
            answerMode={qaMetadata.answerMode}
          />
        )}
      </div>
      {!isStreaming && message.content && (
        <div className={classes.messageActions}>
          <CopyTextButton
            text={message?.content}
            label={t("Copy assistant response")}
          />
        </div>
      )}
    </div>
  );
}

function KnowledgeEvidence({
  citations,
  citationEvidence,
  diagnostics,
  answerMode,
}: {
  citations: AiQaCitation[];
  citationEvidence: AiQaCitationEvidence[];
  diagnostics?: AiQaRetrievalDiagnostics;
  answerMode?: "knowledge" | "no_match";
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const evidenceBySourceId = new Map(
    citationEvidence.map((evidence) => [evidence.sourcePageId, evidence]),
  );
  const isNoMatch = answerMode === "no_match";
  const hasCitations = citations.length > 0;

  return (
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

      {hasCitations && (
        <div className={classes.citationSources}>
          {citations.map((source) => {
            const evidence = evidenceBySourceId.get(source.sourcePageId);
            return (
              <div key={source.sourcePageId} className={classes.citationSource}>
                <button
                  type="button"
                  className={classes.citationSourceLink}
                  onClick={() => navigate(source.url)}
                >
                  <span>{source.title}</span>
                  <IconExternalLink size={13} />
                </button>
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
  );
}

function readQaMetadata(metadata: Record<string, unknown> | null) {
  const citations = readCitations(metadata?.citations);
  const citationEvidence = readCitationEvidence(metadata?.citationEvidence);
  const diagnostics = isRecord(metadata?.retrievalDiagnostics)
    ? (metadata?.retrievalDiagnostics as AiQaRetrievalDiagnostics)
    : undefined;
  const answerMode: "knowledge" | "no_match" | undefined =
    metadata?.answerMode === "knowledge" || metadata?.answerMode === "no_match"
      ? metadata.answerMode
      : undefined;

  return {
    citations,
    citationEvidence,
    diagnostics,
    answerMode,
    hasQaMetadata: Boolean(
      answerMode || diagnostics || citations.length || citationEvidence.length,
    ),
  };
}

function readCitationEvidence(value: unknown): AiQaCitationEvidence[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.sourcePageId !== "string" ||
      typeof item.title !== "string" ||
      typeof item.url !== "string" ||
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
        url: item.url,
        excerpts,
      },
    ];
  });
}

function readCitations(value: unknown): AiQaCitation[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is AiQaCitation =>
      isRecord(item) &&
      typeof item.sourcePageId === "string" &&
      typeof item.title === "string" &&
      typeof item.url === "string",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function progressLabel(stage?: AiQaProgressStage | null): string {
  if (stage === "permissions") return "Checking knowledge access...";
  if (stage === "retrieval") return "Searching the knowledge base...";
  if (stage === "generation") return "Generating a grounded answer...";
  return "Preparing knowledge answer...";
}
