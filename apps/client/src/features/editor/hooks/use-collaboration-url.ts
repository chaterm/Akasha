import { getCollaborationUrl } from "@/lib/config.ts";

export function buildCollaborationUrl(
  baseUrl: string,
  readOnly: boolean,
): string {
  const url = new URL(baseUrl);
  url.searchParams.set("readOnly", String(readOnly));
  return url.toString();
}

const useCollaborationURL = (readOnly = false): string => {
  return buildCollaborationUrl(getCollaborationUrl(), readOnly);
};

export default useCollaborationURL;
