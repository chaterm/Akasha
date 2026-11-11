import { atom } from "jotai";
import { Editor } from "@tiptap/core";
import { HocuspocusProvider } from "@hocuspocus/provider";

export const pageEditorAtom = atom<Editor | null>(null);

export const pageCollabProviderAtom = atom<HocuspocusProvider | null>(
  null as HocuspocusProvider | null,
);

export const titleEditorAtom = atom<Editor | null>(null);

export const readOnlyEditorAtom = atom<Editor | null>(null);

export const yjsConnectionStatusAtom = atom<string>("");

export const showAiMenuAtom = atom(false);

export const showLinkMenuAtom = atom(false);

export type LightboxRequest = {
  src: string;
  type: "image" | "video";
} | null;

const initialLightboxRequest: LightboxRequest = null;
export const lightboxRequestAtom = atom(initialLightboxRequest);
