import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';

import './styles/globals.css';
import { Shell } from './shells/Shell';
import { Board } from './routes/Board';
import { Queue } from './routes/Queue';
import { Placeholder } from './routes/Placeholder';
import { ErrorBoundary } from './components/ErrorBoundary';

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
      { path: 'calendar', element: <Placeholder title="Calendar" phase="Phase 6" /> },
      { path: 'points', element: <Placeholder title="Points" phase="Phase 3" /> },
      { path: 'queue', element: <Queue /> },
      { path: 'rewards', element: <Placeholder title="Rewards" phase="Phase 3" /> },
      { path: 'me', element: <Placeholder title="Me" phase="Phase 1" /> },
      { path: 'settings', element: <Placeholder title="Settings" phase="Phase 1" /> },
      { path: 'kiosk/enroll', element: <Placeholder title="Enroll this tablet" phase="Phase 1" /> },
      { path: '*', element: <Placeholder title="Not found" phase="404" /> },
    ],
  },
]);

const isKiosk = document.documentElement.dataset['surface'] === 'kiosk';

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
