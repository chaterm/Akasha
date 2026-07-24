import {
  IconSparkles,
  IconSearch,
  IconFileText,
  IconArrowsSplit2,
  IconRoute,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import ChatInput from "./chat-input";
import type { ChatAttachment, PageMention } from "../types/ai-chat.types";
import classes from "../styles/ai-chat.module.css";

type Suggestion = {
  icon: React.ReactNode;
  text: string;
  prompt: string;
};

const SUGGESTIONS: Suggestion[] = [
  {
    icon: <IconSearch size={16} />,
    text: "Find answers across the knowledge base",
    prompt: "What does our knowledge base say about ",
  },
  {
    icon: <IconArrowsSplit2 size={16} />,
    text: "Compare concepts across pages",
    prompt: "Compare the knowledge base information about ",
  },
  {
    icon: <IconFileText size={16} />,
    text: "Summarize a knowledge topic",
    prompt: "Summarize what the knowledge base says about ",
  },
  {
    icon: <IconRoute size={16} />,
    text: "Explain a process or procedure",
    prompt: "Explain the documented process for ",
  },
];

type Props = {
  isStreaming: boolean;
  onSend: (
    content: string,
    mentions: PageMention[],
    attachments: ChatAttachment[],
  ) => void;
  onStop: () => void;
};

export default function ChatEmptyState({ isStreaming, onSend, onStop }: Props) {
  const { t } = useTranslation();

  const handleSuggestionClick = (prompt: string) => {
    onSend(prompt, [], []);
  };

  return (
    <div className={classes.emptyState}>
      <IconSparkles size={48} stroke={1.5} className={classes.emptyStateIcon} />
      <div className={classes.emptyStateBrand}>{t("Akasha Knowledge")}</div>
      <h1 className={classes.emptyStateTitle}>
        {t("What would you like to know?")}
      </h1>

      <div className={classes.emptyStateInput}>
        <ChatInput
          isStreaming={isStreaming}
          onSend={onSend}
          onStop={onStop}
          placeholder={t("Ask the knowledge base... Use @ to mention pages")}
          autofocus
        />
      </div>

      <div className={classes.suggestionsSection}>
        <h2 className={classes.suggestionsLabel}>{t("Get started")}</h2>
        <div className={classes.suggestionsGrid}>
          {SUGGESTIONS.map((s) => (
            <button
              key={s.text}
              type="button"
              className={classes.suggestionCard}
              onClick={() => handleSuggestionClick(s.prompt)}
            >
              <span className={classes.suggestionIcon}>{s.icon}</span>
              <span className={classes.suggestionText}>{s.text}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
