import { Document } from "@tiptap/extension-document";

export const TiptapDocument = Document.extend({
  content: "block+",
  allowGapCursor: true,
});
