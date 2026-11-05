import { Loader, Paper, ScrollArea } from "@mantine/core";
import DOMPurify from "dompurify";
import { markdownToHtml } from "@docmost/editor-ext";
import { memo, useEffect, useRef } from "react";
import type { AiTurn } from "./ai-menu.utils";
import classes from "./ai-menu.module.css";

interface ResultPreviewProps {
  turns: AiTurn[];
  isLoading: boolean;
  showPrompts: boolean;
}

const ResultPreview = memo(
  ({ turns, isLoading, showPrompts }: ResultPreviewProps) => {
    const viewportRef = useRef<HTMLDivElement>(null);
    const lastOutput = turns.at(-1)?.output;

    useEffect(() => {
      const viewport = viewportRef.current;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    }, [turns.length, lastOutput]);

    if (turns.length === 0) return null;

    return (
      <Paper mb={4} shadow="lg" radius="md" className={classes.resultPreview}>
        <ScrollArea.Autosize
          mah={360}
          type="scroll"
          scrollbarSize={5}
          viewportRef={viewportRef}
        >
          <div className={classes.resultPreviewWrapper}>
            {turns.map((turn, index) => (
              <div key={index} className={classes.turn}>
                {showPrompts && <div className={classes.turnPrompt}>{turn.prompt}</div>}
                {turn.output && (
                  <div
                    dangerouslySetInnerHTML={{
                      __html: DOMPurify.sanitize(
                        markdownToHtml(turn.output) as string,
                      ),
                    }}
                  />
                )}
              </div>
            ))}
            {isLoading && <Loader size={12} ml="xs" display="inline-block" />}
          </div>
        </ScrollArea.Autosize>
      </Paper>
    );
  },
);

export { ResultPreview };
