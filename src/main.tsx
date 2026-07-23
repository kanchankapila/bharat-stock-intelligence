import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "./lib/trpc";
import { initSentry } from "./lib/sentry";
import { auth } from "./lib/firebase";
import App from './App.tsx';
import './index.css';

// No-op without VITE_SENTRY_DSN. Init before render so it can capture render-time errors too.
initSentry();

// superjson v2 changed serialize() to accept SuperJSONValue instead of unknown,
// which breaks tRPC's DataTransformer structural type check — cast to any as workaround.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const transformer = superjson as any;

const Main = () => {
  const [queryClient] = useState(() => new QueryClient({
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
          <App />
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
