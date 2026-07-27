import { QueryClient } from "@tanstack/react-query";
import { isConnectivityError } from "./sessionGate";

// Cold-reopen resilience (native APK bug, 27 Jul 2026): right after Android
// spawns a fresh process the first requests can die at transport level (radio/
// DNS warm-up — axios "Network Error", no HTTP response) even though the
// device is online. With a single retry and no reconnect signal wired, one bad
// second at launch froze every tab on an error state forever. Network-CLASS
// failures (no response — the retry-later class) now get up to 3 attempts with
// the default exponential backoff; anything with an HTTP response is a server
// decision and keeps the old single retry so real errors surface fast.
export function retryPolicy(failureCount: number, error: unknown): boolean {
  return failureCount < (isConnectivityError(error) ? 3 : 1);
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: retryPolicy,
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    },
  },
});
