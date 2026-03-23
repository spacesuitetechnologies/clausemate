import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: 60_000,
      retry: 1,
      gcTime: 5 * 60_000,
    },
    mutations: {
      retry: false,
    },
  },
});
