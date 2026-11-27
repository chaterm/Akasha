import { useRef, useState, type DragEvent } from "react";
import {
  NodeViewContent,
  type NodeViewProps,
  NodeViewWrapper,
  useEditorState,
} from "@tiptap/react";
import { IconUpload } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { AttachmentFileIcon } from "@/features/attachments/components/attachment-file-icon";
import { userAtom } from "@/features/user/atoms/current-user-atom";
import { useAtomValue } from "jotai";
import { uploadFile } from "@/features/page/services/page-service";
import { getFileUploadSizeLimit, getFileUrl } from "@/lib/config";
import { formatBytes } from "@/lib";
import { notifications } from "@mantine/notifications";
import { notifyError } from "@/lib/errors";
import classes from "./file-list.module.css";

export function FileListRow({ node }: Pick<NodeViewProps, "node">) {
  const { t } = useTranslation();
  const { url, name, mime, modifiedAt, modifiedBy, comment } = node.attrs;
  const fileExt = name?.match(/\.[^.]+$/)?.[0];

  return (
    <NodeViewWrapper className={classes.row} data-drag-handle>
      <div className={classes.filename} contentEditable={false}>
        <AttachmentFileIcon fileExt={fileExt} mimeType={mime} size={22} />
        <div>
          {url ? (
            <a href={getFileUrl(url)} target="_blank" rel="noopener noreferrer">
              {name}
            </a>
          ) : (
            <span title={t("File is unavailable")}>{name}</span>
          )}
          {comment && <div className={classes.comment}>{comment}</div>}
        </div>
      </div>
      <div className={classes.modified} contentEditable={false}>
        {modifiedAt && <time dateTime={modifiedAt}>{modifiedAt}</time>}
        {modifiedAt && modifiedBy && " "}
        {modifiedBy}
      </div>
    </NodeViewWrapper>
  );
}

export default function FileListView({ editor, node, getPos }: NodeViewProps) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const user = useAtomValue(userAtom);
  const pageId = useEditorState({
    editor,
    selector: ({ editor }) =>
      editor.isEditable
        ? (editor.storage as unknown as { pageId?: string }).pageId
        : undefined,
  });

  async function addFiles(files: File[]) {
    if (!pageId || busy.current || !files.length) return;
    busy.current = true;
    setUploading(true);
    try {
      for (const file of files) {
        const pos = getPos();
        const list = pos === undefined ? null : editor.state.doc.nodeAt(pos);
        if (
          editor.isDestroyed ||
          !editor.isEditable ||
          list?.type.name !== "fileList"
        )
          break;
        if (file.size > getFileUploadSizeLimit()) {
          notifications.show({
            color: "red",
            message: t("File exceeds the {{limit}} attachment limit", {
              limit: formatBytes(getFileUploadSizeLimit()),
            }),
          });
          continue;
        }

        try {
          const attachment = await uploadFile(file, pageId);
          const currentPos = getPos();
          if (
            editor.isDestroyed ||
            !editor.isEditable ||
            currentPos === undefined
          )
            break;
          const currentList = editor.state.doc.nodeAt(currentPos);
          if (currentList?.type.name !== "fileList") break;
          const row = editor.schema.nodes.attachment.create({
            attachmentId: attachment.id,
            url: `/api/files/${attachment.id}/${encodeURIComponent(attachment.fileName)}`,
            name: attachment.fileName,
            mime: attachment.mimeType,
            size: attachment.fileSize,
            modifiedAt: attachment.updatedAt?.slice(0, 10),
            modifiedBy: user?.name || null,
          });
          editor.view.dispatch(
            editor.state.tr.insert(currentPos + currentList.nodeSize - 1, row),
          );
        } catch (err) {
          notifyError(err, "Failed to upload file");
        }
      }
    } finally {
      busy.current = false;
      setUploading(false);
    }
  }

  function handleDragOver(event: DragEvent<HTMLButtonElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    setDragging(true);
  }

  return (
    <NodeViewWrapper className={classes.list} data-file-list="">
      <div className={classes.header} contentEditable={false}>
        <span>{t("File")}</span>
        <span>{t("Modified")}</span>
      </div>
      <NodeViewContent />
      {!node.childCount && (
        <div className={classes.empty} contentEditable={false}>
          {t("No files")}
        </div>
      )}
      {pageId && (
        <div contentEditable={false}>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              void addFiles(files);
            }}
          />
          <button
            type="button"
            className={classes.dropZone}
            disabled={uploading}
            data-dragging={dragging || undefined}
            onClick={() => input.current?.click()}
            onDragOver={handleDragOver}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              if (!event.dataTransfer.files.length) return;
              event.preventDefault();
              event.stopPropagation();
              setDragging(false);
              void addFiles(Array.from(event.dataTransfer.files));
            }}
          >
            <IconUpload size={18} />
            {uploading ? t("Uploading files…") : t("Drop files here or browse")}
          </button>
        </div>
      )}
    </NodeViewWrapper>
  );
}
