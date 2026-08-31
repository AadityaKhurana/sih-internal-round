import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import 'leaflet/dist/leaflet.css';
import './styles/tokens.css';
import './styles/global.css';
import './components/ui/ui.css';
import './styles/map.css';

import { App } from './App';
import { LiveProvider } from './features/live/LiveProvider';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A control-room screen is left open for hours; refetching on every window
      // focus would hammer the API for no benefit. Live data is pushed instead.
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 30_000,
    },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {/* LiveProvider sits inside the router so navigation cannot tear down the
            socket, and inside QueryClientProvider because it invalidates queries
            when the feed reconnects. */}
        <LiveProvider>
          <App />
        </LiveProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
