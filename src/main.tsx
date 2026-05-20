import { StrictMode, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "./lib/trpc";
import App from './App.tsx';
import BharatQuantProTerminal from './components/BharatQuantProTerminal.tsx';
import AlphaQuantV3 from './v3/AlphaQuantV3.tsx';
import './index.css';

// superjson v2 changed serialize() to accept SuperJSONValue instead of unknown,
// which breaks tRPC's DataTransformer structural type check — cast to any as workaround.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const transformer = superjson as any;

const Main = () => {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: "/api/trpc",
          transformer,
        }),
      ],
    })
  );

  const [appVersion, setAppVersion] = useState<'v1' | 'v2' | 'v3'>(() => {
    const saved = localStorage.getItem('appVersion');
    if (saved === 'v1' || saved === 'v2' || saved === 'v3') return saved;
    // For legacy compat, check useV2
    const legacyUseV2 = localStorage.getItem('useV2');
    if (legacyUseV2 === 'true') return 'v2';
    if (legacyUseV2 === 'false') return 'v1';
    return 'v3'; // Default to newest V3
  });

  const handleSwitchVersion = (version: 'v1' | 'v2' | 'v3') => {
    localStorage.setItem('appVersion', version);
    setAppVersion(version);
  };

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {appVersion === 'v3' && (
          <AlphaQuantV3 onSwitchVersion={handleSwitchVersion} />
        )}
        
        {appVersion === 'v2' && (
          <BharatQuantProTerminal 
            onToggleLegacy={() => handleSwitchVersion('v1')} 
          />
        )}
        
        {appVersion === 'v1' && (
          <>
            <App />
            <div className="fixed bottom-6 right-6 z-[99999] pointer-events-auto flex flex-col gap-2">
              <button
                onClick={() => handleSwitchVersion('v3')}
                className="flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white px-4 py-2.5 rounded-full text-xs font-black tracking-widest uppercase transition-all shadow-[0_0_24px_rgba(16,185,129,0.5)] border border-emerald-400/20 hover:scale-105 cursor-pointer"
              >
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                Switch to V3 NextGen
              </button>
              <button
                onClick={() => handleSwitchVersion('v2')}
                className="flex items-center gap-2 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white px-4 py-2.5 rounded-full text-xs font-black tracking-widest uppercase transition-all shadow-[0_0_24px_rgba(99,102,241,0.5)] border border-indigo-400/20 hover:scale-105 cursor-pointer"
              >
                Switch to V2
              </button>
            </div>
          </>
        )}
      </QueryClientProvider>
    </trpc.Provider>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Main />
  </StrictMode>,
);
