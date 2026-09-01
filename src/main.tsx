import { StrictMode, Suspense, lazy, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "./lib/trpc";
import { initSentry, captureException } from "./lib/sentry";
import { auth } from "./lib/firebase";
import App from './App';
import './index.css';

// Standalone design-direction concept (no shell, no backend, all data simulated client-side).
const ConceptLedger = lazy(() => import('./concept/ConceptLedger'));


// No-op without VITE_SENTRY_DSN. Init before render so it can capture render-time errors too.
initSentry();

// superjson v2 changed serialize() to accept SuperJSONValue instead of unknown,
// which breaks tRPC's DataTransformer structural type check — cast to any as workaround.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const transformer = superjson as any;

const Main = () => {
  const [queryClient] = useState(() => new QueryClient({
    // Measured 2026-08-15: 104 of 155 .tsx files branch on `isLoading`; only 14 branch on
    // `isError`, and 0 of the 15 widgets composing the v6 default home do. A failed query
    // therefore renders as a skeleton that spins forever -- visually identical to "still
    // loading", on a stock-analysis surface where a user could reasonably read a blank panel
    // as "no signals today" rather than "this request failed".
    //
    // This is the client-side instance of the platform's dominant "looks healthy, is actually
    // broken" class (.claude/rules/recurring-bugs.md's monitoring blind spots, and the
    // data-honesty-review findings on getInstitutionalFlows / DataHealthChip). Fixing it per
    // component would mean editing ~90 files; a QueryCache-level handler covers every existing
    // query and every future one from one place.
    //
    // Deliberately reports rather than renders: react-query has no global error UI, and
    // inventing one here would fight 155 components' own layouts. Sentry (no-op without
    // VITE_SENTRY_DSN) turns a silent skeleton into something that shows up in triage, and the
    // console.error makes it visible in a browser session. Per-surface error states are still
    // the real fix for the highest-traffic widgets -- this stops the failure being INVISIBLE,
    // it does not make it pretty.
    queryCache: new QueryCache({
      onError: (error, query) => {
        const key = Array.isArray(query.queryKey) ? JSON.stringify(query.queryKey[0]) : String(query.queryKey);
        console.error(`[query] ${key} failed:`, error);
        captureException(error, { queryKey: key });
      },
    }),
    defaultOptions: {
      queries: {
        // Treat server data as fresh for 5 minutes — prevents refetch on every tab switch.
        // Procedures with live data (prices, queue stats) override this with their own staleTime.
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
      },
    },
  }));
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: "/api/trpc",
          transformer,
          async headers() {
            const idToken = await auth.currentUser?.getIdToken();
            return idToken ? { authorization: `Bearer ${idToken}` } : {};
          },
        }),
      ],
    })
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route path="/concept" element={<Suspense fallback={null}><ConceptLedger /></Suspense>} />
            <Route path="/*" element={<App />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </trpc.Provider>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Main />
  </StrictMode>,
);
