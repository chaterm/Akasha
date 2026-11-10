import { useEffect, useRef, useState } from "react";
import { IconChevronRight, IconLoader2 } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type {
  AiChatThinkingItem,
  AiChatThinkingStep,
} from "../types/ai-chat.types";
import classes from "../styles/chat-message.module.css";

type Props = {
  steps: AiChatThinkingItem[];
  isStreaming: boolean;
  hasAnswerContent: boolean;
};

export default function ThinkingProcess({
  steps,
  isStreaming,
  hasAnswerContent,
}: Props) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(isStreaming && !hasAnswerContent);
  const hadAnswerContent = useRef(hasAnswerContent);
  const activeStep = [...steps]
    .reverse()
    .find((step) => step.status === "started");
  const elapsedMs = useThinkingElapsed(steps, Boolean(activeStep));
  const headerActiveStep = hasAnswerContent ? undefined : activeStep;

  useEffect(() => {
    if (!hadAnswerContent.current && hasAnswerContent) setIsOpen(false);
    hadAnswerContent.current = hasAnswerContent;
  }, [hasAnswerContent]);

  if (steps.length === 0) return null;

  const header = headerActiveStep
    ? t(activeStepHeader(headerActiveStep.step))
    : t(
        steps.some((step) => step.step === "searching")
          ? "Search completed"
          : "Thinking completed",
      );
  const elapsedSeconds = Math.max(1, Math.round(elapsedMs / 1000));

  return (
    <details
      className={classes.thinkingProcess}
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
      data-streaming={isStreaming || undefined}
    >
      <summary className={classes.thinkingHeader}>
        {headerActiveStep && (
          <IconLoader2 size={15} className={classes.processingSpinner} />
        )}
        <span>{header}</span>
        <span className={classes.thinkingElapsed}>
          {t("{{count}}s", { count: elapsedSeconds })}
        </span>
        {(!isStreaming || hasAnswerContent) && (
          <span className={classes.thinkingPrivacy}>
            {t("Results are only visible to you")}
          </span>
        )}
        <IconChevronRight className={classes.thinkingChevron} size={15} />
      </summary>

      <div className={classes.thinkingTimeline}>
        {steps.map((step) => (
          <div
            key={step.step}
            className={classes.thinkingStep}
            data-status={step.status}
          >
            <span className={classes.thinkingMarker} aria-hidden="true">
              {step.status === "started" ? (
                <IconLoader2 size={12} className={classes.processingSpinner} />
              ) : (
                <span className={classes.thinkingDot} />
              )}
            </span>
            <div className={classes.thinkingStepBody}>
              <div className={classes.thinkingStepTitle}>
                {t(stepTitle(step.step))}
              </div>
              {stepDetails(step).map((detail) => (
                <div key={detail.key} className={classes.thinkingStepDetail}>
                  {t(detail.key, detail.values)}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

function useThinkingElapsed(
  steps: AiChatThinkingItem[],
  hasActiveStep: boolean,
): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!hasActiveStep) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasActiveStep]);

  return steps.reduce((total, step) => {
    if (typeof step.durationMs === "number") {
      return total + step.durationMs;
    }
    if (step.status === "started" && step.startedAt) {
      return total + Math.max(0, now - step.startedAt);
    }
    return total;
  }, 0);
}

function activeStepHeader(step: AiChatThinkingStep): string {
  if (step === "understanding") return "Understanding the question...";
  if (step === "searching") return "Searching the knowledge base...";
  if (step === "analyzing") return "Analyzing relevant knowledge...";
  if (step === "fallback") return "Switching answer mode...";
  return "Organizing information and preparing the answer...";
}

function stepTitle(step: AiChatThinkingStep): string {
  if (step === "understanding") return "Understand and analyze the question";
  if (step === "searching") return "Find relevant knowledge";
  if (step === "analyzing") return "Analyze relevant knowledge";
  if (step === "fallback") return "Switch answer mode";
  return "Organize information and prepare the answer";
}

type StepDetail = {
  key: string;
  values?: Record<string, number | string>;
};

function stepDetails(step: AiChatThinkingItem): StepDetail[] {
  const stats = step.stats ?? {};
  if (step.status === "started") {
    if (step.step === "understanding") {
      return [{ key: "Reviewing the question and recent conversation" }];
    }
    if (step.step === "searching") {
      return [{ key: "Searching content you can access" }];
    }
    if (step.step === "analyzing") {
      return [{ key: "Filtering and organizing the retrieved material" }];
    }
    if (step.step === "fallback") {
      return [
        {
          key: "Knowledge evidence is insufficient; switching to a general answer",
        },
      ];
    }
    return [{ key: "Checking the evidence and preparing the answer" }];
  }

  if (step.step === "understanding") {
    if ((stats.historyMessageCount ?? 0) > 0 && stats.queryRewritten) {
      return [
        {
          key: "Used {{count}} recent messages to clarify the question",
          values: { count: stats.historyMessageCount! },
        },
      ];
    }
    if ((stats.historyMessageCount ?? 0) > 0) {
      return [
        {
          key: "Reviewed {{count}} recent messages; the question was already clear",
          values: { count: stats.historyMessageCount! },
        },
      ];
    }
    return [{ key: "Question intent identified" }];
  }

  if (step.step === "searching") {
    if ((stats.matchedChunkCount ?? 0) === 0) {
      return [{ key: "No sufficiently relevant knowledge was retained" }];
    }
    const details: StepDetail[] = [
      {
        key: "Found {{count}} relevant knowledge chunks",
        values: { count: stats.matchedChunkCount! },
      },
    ];
    if ((stats.sourceCount ?? 0) > 0) {
      details.push({
        key: "Matched {{count}} readable sources",
        values: { count: stats.sourceCount! },
      });
    }
    return details;
  }

  if (step.step === "analyzing") {
    if (step.outcome === "insufficient") {
      return [
        {
          key: "The retrieved material was insufficient for a grounded answer",
        },
      ];
    }
    return [
      {
        key: "Selected {{count}} knowledge items for the answer",
        values: { count: stats.includedItemCount ?? 0 },
      },
    ];
  }

  if (step.step === "fallback") {
    return [{ key: "Switched to a general-knowledge answer" }];
  }

  if (step.outcome === "insufficient") {
    return [{ key: "Knowledge evidence was insufficient" }];
  }
  if (step.outcome === "general") {
    return [{ key: "General-knowledge answer prepared" }];
  }
  return [{ key: "Evidence organized and answer prepared" }];
}
