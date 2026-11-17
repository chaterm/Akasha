import { EditorProvider } from "@tiptap/react";
import { useMemo } from "react";
import { mainExtensions } from "@/features/editor/extensions/extensions";
import { UniqueID, ADDRESSABLE_NODE_TYPES } from "@docmost/editor-ext";

type Props = {
  content: unknown;
};

export default function TransclusionContent({ content }: Props) {
  const extensions = useMemo(() => {
    const filtered = mainExtensions.filter(
      (e: any) => e.name !== "uniqueID" && e.name !== "globalDragHandle",
    );
    return [
      ...filtered,
      UniqueID.configure({
        types: [...ADDRESSABLE_NODE_TYPES],
        updateDocument: false,
      }),
    ];
  }, []);

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div
      onMouseDown={stop}
      onClick={stop}
      onDragStart={stop}
      onDragOver={stop}
      onDrop={stop}
    >
      <EditorProvider
        editable={false}
        immediatelyRender={true}
        extensions={extensions}
        content={content as any}
      />
    </div>
  );
}
