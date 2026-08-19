import api from "@/lib/api-client";
import {
  ICreateApiKeyRequest,
  ICreatePublicApiKeyRequest,
  IApiKey,
  IUpdateApiKeyRequest,
  IUpdatePublicApiKeyRequest,
} from "@/ee/api-key/types/api-key.types";
import { IPagination, QueryParams } from "@/lib/types.ts";

export async function getApiKeys(
  params?: QueryParams,
): Promise<IPagination<IApiKey>> {
  const { adminView, ...rest } = params ?? {};
  const endpoint = adminView ? "/api-keys/workspace" : "/api-keys";
  const req = await api.post(endpoint, { ...rest });
  return req.data;
}

export async function getPublicApiKeys(
  params?: QueryParams,
): Promise<IPagination<IApiKey>> {
  const req = await api.post("/api-keys/public", { ...params });
  return req.data;
}

export async function createApiKey(
  data: ICreateApiKeyRequest,
): Promise<IApiKey> {
  const req = await api.post<IApiKey>("/api-keys/create", data);
  return req.data;
}

export async function getPublicApiKeySpaces(): Promise<
  Array<{ id: string; name: string }>
> {
  const req = await api.post("/api-keys/public/spaces");
  return req.data;
}

export async function createPublicApiKey(
  data: ICreatePublicApiKeyRequest,
): Promise<IApiKey> {
  const req = await api.post<IApiKey>("/api-keys/public/create", data);
  return req.data;
}

export async function updateApiKey(
  data: IUpdateApiKeyRequest,
): Promise<IApiKey> {
  const req = await api.post<IApiKey>("/api-keys/update", data);
  return req.data;
}

export async function updatePublicApiKey(
  data: IUpdatePublicApiKeyRequest,
): Promise<IApiKey> {
  const req = await api.post<IApiKey>("/api-keys/public/update", data);
  return req.data;
}

export async function revokeApiKey(data: { apiKeyId: string }): Promise<void> {
  await api.post("/api-keys/revoke", data);
}
