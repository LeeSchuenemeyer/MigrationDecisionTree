import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';

import './styles/globals.css';
import { Shell } from './shells/Shell';
import { Board } from './routes/Board';
import { Queue } from './routes/Queue';
import { Points } from './routes/Points';
import { Rewards } from './routes/Rewards';
import { Calendar } from './routes/Calendar';
import { Settings } from './routes/Settings';
import { Placeholder } from './routes/Placeholder';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installLastResortReload } from './lib/lastResort';

/**
 * Data policy: nothing polls on its own. A single /api/pulse endpoint reports a
 * household revision counter, and only the slices it says changed are
 * invalidated (Phase 4). That is what keeps a 24/7 wall tablet at roughly
 * 40 MB/month instead of six independent polling queries.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const router = createBrowserRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <Board /> },
      { path: 'calendar', element: <Calendar /> },
      { path: 'points', element: <Points /> },
      { path: 'queue', element: <Queue /> },
      { path: 'rewards', element: <Rewards /> },
      { path: 'me', element: <Placeholder title="Me" phase="Phase 1" /> },
      { path: 'settings', element: <Settings /> },
      { path: 'kiosk/enroll', element: <Placeholder title="Enroll this tablet" phase="Phase 1" /> },
      { path: '*', element: <Placeholder title="Not found" phase="404" /> },
    ],
  },
]);

const isKiosk = document.documentElement.dataset['surface'] === 'kiosk';

// Installed before render, deliberately: the failure it exists for is the one
// where the line below never runs.
installLastResortReload(isKiosk);

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <StrictMode>
    {/* Only the unattended surface reloads itself; on a phone that would yank
        the page out from under someone mid-tap. */}
    <ErrorBoundary autoReloadAfterSeconds={isKiosk ? 30 : null}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
