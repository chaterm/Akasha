import { Editor } from "@tiptap/react";
import { ActionIcon, TextInput } from "@mantine/core";
import { useDebouncedCallback, useMediaQuery } from "@mantine/hooks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAtom } from "jotai";
import { IconArrowUp, IconPlayerStopFilled } from "@tabler/icons-react";
import { showAiMenuAtom } from "@/features/editor/atoms/editor-atoms.ts";
import { useAiGenerateStreamMutation } from "@/features/ai/queries/ai-query.ts";
import { AiAction } from "@/features/ai/types/ai.types.ts";
import {
  AiMenuMode,
  CommandItem,
  CommandSet,
  getVisibleCommandItems,
} from "./command-items.ts";
import { CommandSelector } from "./command-selector.tsx";
import { ResultPreview } from "./result-preview.tsx";
import classes from "./ai-menu.module.css";
import { DOMSerializer } from "@tiptap/pm/model";
import {
  copyToClipboard,
  htmlToMarkdown,
  markdownToHtml,
} from "@docmost/editor-ext";
import { useLocation } from "react-router-dom";
import {
  AiTurn,
  buildHistoryMessages,
  buildPageContext,
  isFocusWithinAiMenu,
  isOutsideAiMenu,
} from "./ai-menu.utils";
import { getSlashCommandItems } from "./slash-items";
import { useTranslation } from "react-i18next";
import { notifyError } from "@/lib/errors";

const GENERATE_SUGGESTIONS = [
  "Compare the key points in a table",
  "Turn this page into an FAQ with toggles",
  "Draw a flowchart of the steps",
];

interface EditorAiMenuProps {
  editor: Editor | null;
  readOnly?: boolean;
}

const EditorAiMenu = ({
  editor,
  readOnly = false,
}: EditorAiMenuProps): JSX.Element | null => {
  const { t } = useTranslation();
  const aiGenerateStreamMutation = useAiGenerateStreamMutation();
  const location = useLocation();
  const isSmBreakpoint = useMediaQuery("(max-width: 48em)");
  const [showAiMenu, setShowAiMenu] = useAtom(showAiMenuAtom);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const streamAbortControllerRef = useRef<AbortController | null>(null);
  const [prompt, setPrompt] = useState("");
  const [turns, setTurns] = useState<AiTurn[]>([]);
  const output = turns.at(-1)?.output ?? "";
  const [isLoading, setIsLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [activeCommandSet, setActiveCommandSet] = useState<CommandSet>("main");
  const [lastAction, setLastAction] = useState<CommandItem | null>(null);
  const [menuPlacement, setMenuPlacement] = useState<{
    top: number;
    left: number;
    width: number;
  }>({
    top: 0,
    left: 0,
    width: 0,
  });
  const [mode, setMode] = useState<AiMenuMode>("transform");
  const [wasOpen, setWasOpen] = useState(showAiMenu);
  if (showAiMenu !== wasOpen) {
    setWasOpen(showAiMenu);
    if (showAiMenu) {
      setMode(editor?.state.selection.empty ? "generate" : "transform");
    }
  }
  const currentItems = useMemo(() => {
    if (mode === "generate" && !readOnly) {
      const slashItems = getSlashCommandItems(prompt, editor);
      if (slashItems) return slashItems;
      if (prompt.trim()) return [];
    }
    return getVisibleCommandItems(mode, activeCommandSet, prompt, readOnly, t);
  }, [mode, prompt, activeCommandSet, readOnly, t, editor]);
  const updateMenuPlacement = useCallback(() => {
    if (!editor || !showAiMenu) return;

    const { view } = editor;
    const { from, to } = editor.state.selection;
    const editorRect = view.dom.getBoundingClientRect();
    const fromCoords = view.coordsAtPos(from);
    const toCoords = view.coordsAtPos(to);
    const topOffset = 8;
    const editorPadding = isSmBreakpoint ? 16 : 48;

    const anchorBottom =
      toCoords.bottom > 0 && toCoords.bottom < window.innerHeight
        ? toCoords.bottom
        : fromCoords.bottom;

    const menuMaxWidth = 600;
    const editorLeft = editorRect.left + editorPadding;
    const editorRight = editorRect.right - editorPadding;
    const availableWidth = editorRight - editorLeft;
    const menuWidth = Math.min(menuMaxWidth, availableWidth);

    let menuLeft = Math.max(editorLeft, fromCoords.left);
    if (menuLeft + menuWidth > editorRight) {
      menuLeft = editorRight - menuWidth;
    }
    menuLeft = Math.max(editorLeft, menuLeft);

    setMenuPlacement({
      top: anchorBottom + topOffset + window.scrollY,
      left: menuLeft + window.scrollX,
      width: menuWidth,
    });
  }, [editor, showAiMenu, isSmBreakpoint]);
  const resetMenu = useCallback(() => {
    streamAbortControllerRef.current?.abort();
    streamAbortControllerRef.current = null;
    setPrompt("");
    setTurns([]);
    setIsLoading(false);
    setSelectedIndex(-1);
    setActiveCommandSet("main");
    setLastAction(null);
    aiGenerateStreamMutation.reset();
  }, [aiGenerateStreamMutation.reset]);
  const debouncedUpdateMenuPlacement = useDebouncedCallback(
    updateMenuPlacement,
    60,
  );
  const handleGenerate = useCallback(
    (item?: CommandItem, { retry = false } = {}) => {
      if (!editor || isLoading) return;

      let command: CommandItem | null = item || null;

      if (!command) {
        if (!prompt.trim()) return;

        command = {
          id: "custom",
          name: "Custom",
          action: mode === "transform" ? AiAction.CUSTOM : AiAction.GENERATE,
          prompt: prompt.trim(),
        };
      }

      const history =
        mode === "generate" ? (retry ? turns.slice(0, -1) : turns) : [];
      const turnPrompt = command.prompt ?? command.name;
      setTurns([...history, { prompt: turnPrompt, output: "" }]);

      let content = "";
      if (mode === "transform") {
        const { from, to } = editor.state.selection;
        const slice = editor.state.doc.slice(from, to);
        const serializer = DOMSerializer.fromSchema(editor.schema);
        const fragment = serializer.serializeFragment(slice.content);
        const wrapper = document.createElement("div");
        wrapper.appendChild(fragment);
        content = htmlToMarkdown(wrapper.innerHTML);
      }

      setIsLoading(true);
      aiGenerateStreamMutation.mutate({
        action: command.action,
        prompt: command.prompt,
        content,
        ...(mode === "generate" && {
          messages: buildHistoryMessages(history),
          pageContent: buildPageContext(editor),
        }),
        onController: (controller) => {
          streamAbortControllerRef.current = controller;
        },
        onChunk: (chunk) => {
          setTurns((turns) => {
            const last = turns.at(-1);
            if (!last) return turns;
            return [
              ...turns.slice(0, -1),
              { ...last, output: last.output + chunk.content },
            ];
          });
        },
        onComplete: () => {
          streamAbortControllerRef.current = null;
          setPrompt("");
          setIsLoading(false);
          setActiveCommandSet("result");
        },
        onError: (error) => {
          streamAbortControllerRef.current = null;
          setIsLoading(false);
          notifyError(error, "AI generation failed");
          if (mode === "generate" && history.length > 0) {
            setTurns(history);
            setPrompt(turnPrompt);
            return;
          }
          resetMenu();
        },
      });
      setLastAction(command);
    },
    [
      editor,
      mode,
      prompt,
      turns,
      isLoading,
      aiGenerateStreamMutation.mutate,
      resetMenu,
    ],
  );
  const handleStop = useCallback(() => {
    if (!isLoading) return;
    streamAbortControllerRef.current?.abort();
    streamAbortControllerRef.current = null;
    setIsLoading(false);

    const last = turns.at(-1);
    if (last?.output) {
      setActiveCommandSet("result");
    } else {
      setTurns(turns.slice(0, -1));
      if (mode === "generate" && last) setPrompt(last.prompt);
      setActiveCommandSet(turns.length > 1 ? "result" : "main");
    }
    requestAnimationFrame(() =>
      inputRef.current?.focus({ preventScroll: true }),
    );
  }, [isLoading, turns, mode]);
  const handleCommand = useCallback(
    (item?: CommandItem) => {
      setPrompt("");

      if (!item) {
        return handleGenerate();
      }
      if (item.id === "back") {
        return setActiveCommandSet("main");
      }
      if (item.slashItem) {
        const { from } = editor.state.selection;
        item.slashItem.command({ editor, range: { from, to: from } });
        return setShowAiMenu(false);
      }
      if (item.id === "result-replace" || item.id === "result-insert") {
        const html = (markdownToHtml(output) as string).trim();
        const isSingleParagraph =
          html.startsWith("<p>") &&
          html.endsWith("</p>") &&
          html.lastIndexOf("<p>") === 0;

        // Strip <p> wrapper for single-paragraph output to preserve inline context,
        // then decode HTML entities via DOMParser since TipTap would otherwise
        // treat the tagless string as plain text and insert entities literally.
        const content = isSingleParagraph
          ? new DOMParser().parseFromString(html.slice(3, -4), "text/html").body
              .innerHTML
          : html;

        editor.chain().focus().insertContent(content).run();

        return setShowAiMenu(false);
      }
      if (item.id === "result-copy") {
        copyToClipboard(output);

        return setShowAiMenu(false);
      }
      if (item.id === "result-discard") {
        return resetMenu();
      }
      if (item.id === "result-try-again" && lastAction) {
        return handleGenerate(lastAction, { retry: true });
      }
      if (item.subCommandSet) {
        return setActiveCommandSet(item.subCommandSet);
      }

      return handleGenerate(item);
    },
    [editor, output, lastAction, handleGenerate, resetMenu, setShowAiMenu],
  );
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      const totalItems = currentItems.length;
      const cycleSize = totalItems + 1;

      if (event.key === "Escape") {
        return setShowAiMenu(false);
      }

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();

        return setSelectedIndex((selectedIndex) => {
          const direction = event.key === "ArrowDown" ? 1 : -1;
          const newIndex = selectedIndex + direction;

          if (newIndex < -1) return cycleSize - 1;
          if (newIndex >= cycleSize) return 0;

          return newIndex;
        });
      }

      if (event.key === "Enter") {
        event.preventDefault();

        return handleCommand(currentItems[selectedIndex]);
      }
    },
    [currentItems, selectedIndex, handleCommand],
  );

  useEffect(() => {
    if (!editor) return;

    const handleFocus = () => setShowAiMenu(false);
    const handleBlur = ({ event }: { event: FocusEvent }) => {
      const nextTarget = event.relatedTarget;

      // Opening the AI menu moves focus from ProseMirror to the prompt input.
      // Keep the menu open when that focus transition is internal to the menu.
      if (isFocusWithinAiMenu(nextTarget, containerRef.current)) {
        return;
      }

      setShowAiMenu(false);
    };
    const observer = new ResizeObserver(() => {
      debouncedUpdateMenuPlacement();
    });

    updateMenuPlacement();
    editor.on("focus", handleFocus);
    editor.on("blur", handleBlur);
    window.addEventListener("resize", debouncedUpdateMenuPlacement);
    window.addEventListener("scroll", debouncedUpdateMenuPlacement, true);
    observer.observe(editor.view.dom);

    return () => {
      editor.off("focus", handleFocus);
      editor.off("blur", handleBlur);
      window.removeEventListener("resize", debouncedUpdateMenuPlacement);
      window.removeEventListener("scroll", debouncedUpdateMenuPlacement, true);
      observer.disconnect();
    };
  }, [editor, updateMenuPlacement, debouncedUpdateMenuPlacement]);

  useEffect(() => {
    if (!showAiMenu) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (isOutsideAiMenu(event.target, containerRef.current)) {
        setShowAiMenu(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [showAiMenu, setShowAiMenu]);

  useEffect(() => {
    setShowAiMenu(false);
  }, [location]);
  useEffect(() => {
    if (showAiMenu) {
      resetMenu();
    } else {
      streamAbortControllerRef.current?.abort();
      streamAbortControllerRef.current = null;
    }
  }, [showAiMenu, resetMenu]);
  useEffect(() => {
    return () => streamAbortControllerRef.current?.abort();
  }, []);
  useEffect(() => {
    // Focus input when menu opens or command set changes
    requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
    });
  }, [showAiMenu, isLoading, currentItems]);
  useEffect(() => {
    if (!currentItems.length) {
      setSelectedIndex(-1);
    }
    setSelectedIndex(prompt || activeCommandSet !== "main" ? 0 : -1);
  }, [prompt, activeCommandSet, currentItems]);

  if (!showAiMenu) return null;

  return createPortal(
    <div
      style={{
        zIndex: 199,
        position: "absolute",
        top: menuPlacement.top,
        left: menuPlacement.left,
        width: menuPlacement.width,
        pointerEvents: "none",
      }}
    >
      <div
        className={classes.aiMenu}
        style={{ pointerEvents: "auto" }}
        tabIndex={0}
        ref={containerRef}
      >
        <ResultPreview
          turns={turns}
          isLoading={isLoading}
          showPrompts={mode === "generate"}
        />
        {mode === "generate" && turns.length === 0 && !prompt && (
          <div className={classes.suggestions}>
            {GENERATE_SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className={classes.suggestion}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setPrompt(t(suggestion));
                  inputRef.current?.focus({ preventScroll: true });
                }}
              >
                {t(suggestion)}
              </button>
            ))}
          </div>
        )}
        <CommandSelector
          selectedIndex={selectedIndex}
          isLoading={isLoading}
          output={output}
          currentItems={currentItems}
          handleCommand={handleCommand}
        >
          <TextInput
            ref={inputRef}
            className={classes.aiInput}
            placeholder={
              mode === "transform"
                ? t("Tell AI how to edit the selection...")
                : turns.length > 0
                  ? t("Ask a follow-up...")
                  : t("Ask AI about this page, or type / to insert a block...")
            }
            data-autofocus
            value={prompt}
            disabled={isLoading}
            onChange={(e) => setPrompt(e.currentTarget.value)}
            rightSectionPointerEvents="all"
            rightSection={
              isLoading ? (
                <ActionIcon
                  variant="filled"
                  color="dark"
                  radius="xl"
                  size="sm"
                  aria-label={t("Stop generation")}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={handleStop}
                >
                  <IconPlayerStopFilled size={12} />
                </ActionIcon>
              ) : (
                <ActionIcon
                  disabled={!prompt.trim()}
                  variant="filled"
                  color="blue"
                  radius="xl"
                  size="sm"
                  aria-label={t("Send message")}
                  onClick={() => handleGenerate()}
                >
                  <IconArrowUp size={14} stroke={2.5} />
                </ActionIcon>
              )
            }
            onKeyDown={handleKeyDown}
          />
        </CommandSelector>
      </div>
    </div>,
    document.body,
  );
};

export { EditorAiMenu };
