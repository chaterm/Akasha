import { AiAction } from "@/features/ai/types/ai.types.ts";
import {
  IconSparkles,
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconWriting,
  IconHelp,
  IconList,
  IconMoodSmile,
  IconLanguage,
  IconTrash,
  IconRefresh,
  IconChevronLeft,
  IconCheck,
  IconArrowDownLeft,
  IconCopy,
  IconTextPlus,
  IconAlignJustified,
} from "@tabler/icons-react";

interface CommandItem {
  name: string;
  id: string;
  icon?: typeof IconSparkles;
  action?: AiAction;
  prompt?: string;
  subCommandSet?: CommandSet;
}

type CommandSet = "main" | "tone" | "translate" | "result";

const mainItems: CommandItem[] = [
  {
    id: "improve-writing",
    name: "Improve writing",
    icon: IconSparkles,
    action: AiAction.IMPROVE_WRITING,
  },
  {
    id: "fix-spelling-grammar",
    name: "Fix spelling & grammar",
    icon: IconCheck,
    action: AiAction.FIX_SPELLING_GRAMMAR,
  },
  {
    id: "make-longer",
    name: "Make longer",
    icon: IconTextPlus,
    action: AiAction.MAKE_LONGER,
  },
  {
    id: "make-shorter",
    name: "Make shorter",
    icon: IconAlignJustified,
    action: AiAction.MAKE_SHORTER,
  },
  {
    id: "continue-writing",
    name: "Continue writing",
    icon: IconWriting,
    action: AiAction.CONTINUE_WRITING,
  },
  {
    id: "explain",
    name: "Explain",
    icon: IconHelp,
    action: AiAction.EXPLAIN,
  },
  {
    id: "summarize",
    name: "Summarize",
    icon: IconList,
    action: AiAction.SUMMARIZE,
  },
  {
    id: "change-tone",
    name: "Change tone",
    icon: IconMoodSmile,
    subCommandSet: "tone",
  },
  {
    id: "translate",
    name: "Translate",
    icon: IconLanguage,
    subCommandSet: "translate",
  },
];
const toneItems: CommandItem[] = [
  {
    id: "back",
    name: "Back",
    icon: IconChevronLeft,
  },
  {
    id: "tone-professional",
    name: "Professional",
    icon: IconMoodSmile,
    action: AiAction.CHANGE_TONE,
    prompt: "专业",
  },
  {
    id: "tone-casual",
    name: "Casual",
    icon: IconMoodSmile,
    action: AiAction.CHANGE_TONE,
    prompt: "轻松",
  },
  {
    id: "tone-friendly",
    name: "Friendly",
    icon: IconMoodSmile,
    action: AiAction.CHANGE_TONE,
    prompt: "友好",
  },
];
const translateItems: CommandItem[] = [
  {
    id: "back",
    name: "Back",
    icon: IconChevronLeft,
  },
  {
    id: "translate-english",
    name: "English",
    icon: IconLanguage,
    action: AiAction.TRANSLATE,
    prompt: "英语",
  },
  {
    id: "translate-spanish",
    name: "Spanish",
    icon: IconLanguage,
    action: AiAction.TRANSLATE,
    prompt: "西班牙语",
  },
  {
    id: "translate-german",
    name: "German",
    icon: IconLanguage,
    action: AiAction.TRANSLATE,
    prompt: "德语",
  },
  {
    id: "translate-french",
    name: "French",
    icon: IconLanguage,
    action: AiAction.TRANSLATE,
    prompt: "法语",
  },
  {
    id: "translate-dutch",
    name: "Dutch",
    icon: IconLanguage,
    action: AiAction.TRANSLATE,
    prompt: "荷兰语",
  },
  {
    id: "translate-portuguese",
    name: "Portuguese",
    icon: IconLanguage,
    action: AiAction.TRANSLATE,
    prompt: "葡萄牙语",
  },
  {
    id: "translate-italian",
    name: "Italian",
    icon: IconLanguage,
    action: AiAction.TRANSLATE,
    prompt: "意大利语",
  },
  {
    id: "translate-japanese",
    name: "Japanese",
    icon: IconLanguage,
    action: AiAction.TRANSLATE,
    prompt: "日语",
  },
  {
    id: "translate-korean",
    name: "Korean",
    icon: IconLanguage,
    action: AiAction.TRANSLATE,
    prompt: "韩语",
  },
  {
    id: "translate-swedish",
    name: "Swedish",
    icon: IconLanguage,
    action: AiAction.TRANSLATE,
    prompt: "瑞典语",
  },
  {
    id: "translate-chinese",
    name: "Chinese (Simplified)",
    icon: IconLanguage,
    action: AiAction.TRANSLATE,
    prompt: "简体中文",
  },
];
const resultItems: CommandItem[] = [
  { id: "result-replace", name: "Replace", icon: IconCheck },
  { id: "result-insert-below", name: "Insert below", icon: IconArrowDownLeft },
  { id: "result-copy", name: "Copy", icon: IconCopy },
  { id: "result-discard", name: "Discard", icon: IconTrash },
  {
    id: "result-try-again",
    name: "Try again",
    icon: IconRefresh,
  },
];
const commandItems: Record<CommandSet, CommandItem[]> = {
  main: mainItems,
  tone: toneItems,
  translate: translateItems,
  result: resultItems,
};

const getVisibleCommandItems = (
  commandSet: CommandSet,
  prompt: string,
  readOnly: boolean,
  translate: (name: string) => string = (name) => name,
) => {
  const query = prompt.toLowerCase();
  const items = commandItems[commandSet].filter(
    (item) =>
      item.name.toLowerCase().includes(query) ||
      translate(item.name).toLowerCase().includes(query),
  );

  if (!readOnly || commandSet !== "result") {
    return items;
  }

  return items.filter(
    (item) => item.id !== "result-replace" && item.id !== "result-insert-below",
  );
};

export type { CommandItem, CommandSet };
export { commandItems, getVisibleCommandItems };
