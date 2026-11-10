import api from "@/lib/api-client";
import { IPagination } from "@/lib/types.ts";
import { IPage } from "@/features/page/types/page.types";
import {
  PageTemplate,
  TemplateDraft,
  TemplateListParams,
} from "./template.types";

export async function listTemplates(
  params: TemplateListParams,
): Promise<IPagination<PageTemplate>> {
  const res = await api.post("/templates", params);
  return res.data;
}

export async function fetchTemplate(templateId: string): Promise<PageTemplate> {
  const res = await api.post<PageTemplate>("/templates/info", { templateId });
  return res.data;
}

export async function createTemplate(
  draft: TemplateDraft & { title: string; sourcePageId?: string },
): Promise<PageTemplate> {
  const res = await api.post<PageTemplate>("/templates/create", draft);
  return res.data;
}

export async function saveTemplate(
  templateId: string,
  draft: TemplateDraft,
): Promise<PageTemplate> {
  const res = await api.post<PageTemplate>("/templates/update", {
    templateId,
    ...draft,
  });
  return res.data;
}

export async function removeTemplate(templateId: string): Promise<void> {
  await api.post("/templates/delete", { templateId });
}

export async function createPageFromTemplate(input: {
  templateId: string;
  spaceId: string;
  parentPageId?: string;
}): Promise<IPage> {
  const res = await api.post<IPage>("/templates/use", input);
  return res.data;
}
