import { QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api-error";

export function clearSession(client: QueryClient) {
  void client.cancelQueries({ queryKey: ["me"], exact: true });
  // Keep the observed profile query alive so mounted subscribers see sign-out.
  client.setQueryData(["me"], null);
  client.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
}

export function createAppQueryClient() {
  const client = new QueryClient({
    queryCache: new QueryCache({ onError: (error) => {
      if (error instanceof ApiError && error.status === 401) clearSession(client);
    } }),
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
  });
  return client;
}
