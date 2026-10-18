import { readActiveWorkspaceToken } from "../workspaceConnections";
export async function externalSourceFetch<T>(
  db: string, databaseId: bigint, params: Record<string, string> = {}, method = "GET", signal?: AbortSignal,
): Promise<T> {
  const token = readActiveWorkspaceToken();
  if (!token) throw new Error("Sign in to use external data sources");
  const query = new URLSearchParams({ db, databaseId: String(databaseId), ...params });
  const response = await fetch(`/api/integrations/external-source?${query}`, {
    method, headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "External source request failed");
  return body as T;
}
