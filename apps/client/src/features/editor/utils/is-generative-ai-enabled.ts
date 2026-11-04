import { getDefaultStore } from "jotai";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom";

export const isGenerativeAiEnabled = () =>
  getDefaultStore().get(workspaceAtom)?.settings?.ai?.generative === true;
