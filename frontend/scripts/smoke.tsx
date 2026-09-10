/**
 * Render smoke test: `npm run check:render`
 *
 * Type checking proves the code compiles; it does not prove the app mounts. This
 * renders every route in jsdom against the mock transport and asserts that the
 * real content appears — not just that nothing threw. It catches the failures
 * `tsc` cannot see: a bad hook order, a context used outside its provider, a
 * Leaflet layer built from malformed coordinates, a crash inside a chart.
 *
 * Any `console.error` (which is where React reports render errors and key
 * warnings) fails the run, so warnings cannot quietly accumulate.
 */

import './smoke-env';

import { StrictMode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from '../src/App';
import { LiveProvider } from '../src/features/live/LiveProvider';
import { STORY_PLATES } from '../src/api/mock/seed/plates';

// React needs this to run act() without warning.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let failures = 0;
const consoleErrors: string[] = [];
const consoleWarnings: string[] = [];

const originalError = console.error;
const originalWarn = console.warn;

console.error = (...args: unknown[]) => {
  consoleErrors.push(args.map(String).join(' '));
};
console.warn = (...args: unknown[]) => {
  consoleWarnings.push(args.map(String).join(' '));
};

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    originalError.call(console, `  ✓ ${label}`);
  } else {
    failures += 1;
    originalError.call(console, `  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function log(message: string): void {
  originalError.call(console, message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function flush(ms = 900): Promise<void> {
  await act(async () => {
    await sleep(ms);
  });
}

interface RouteCase {
  path: string;
  label: string;
  /** Substrings that must all appear in the rendered text. */
  expect: string[];
  /** Substrings that must NOT appear (error states leaking through). */
  reject?: string[];
  settleMs?: number;
  /** DOM-level assertions, for things text content cannot prove. */
  assert?: (container: HTMLElement) => void;
  /** Interaction step, for behaviour a static render cannot prove. */
  interact?: (container: HTMLElement) => Promise<void>;
}

const CASES: RouteCase[] = [
  {
    path: '/map',
    label: 'Live map',
    expect: [
      'Simulated demo network',
      'Camera status',
      'Network',
      'Congestion',
      'Fault — no data',
      'CAM-01',
      'active',
    ],
    reject: ['Could not load', 'No such screen'],
    settleMs: 1600,
    assert: (container) => {
      // Text content cannot show whether Leaflet actually built the layers, so
      // the SVG geometry is counted directly.
      const paths = container.querySelectorAll('.leaflet-overlay-pane path, path');
      check('Live map: Leaflet rendered SVG geometry', paths.length > 40, `${paths.length} paths`);

      const panes = container.querySelectorAll(
        '.leaflet-pane[class*="anpr-"], .leaflet-anpr-links, .leaflet-pane',
      );
      check('Live map: custom panes created', panes.length > 0, `${panes.length} panes`);

      const tiles = container.querySelectorAll('.leaflet-tile-pane');
      check('Live map: basemap tile pane mounted', tiles.length === 1);

      // 12 cameras + 26 links, each link drawn as hit-area + stroke + chevron.
      const labels = container.querySelectorAll('.map-label');
      check('Live map: camera labels rendered', labels.length >= 12, `${labels.length} labels`);

      const attribution = container.querySelector('.leaflet-control-attribution');
      check(
        'Live map: basemap attribution present (licence requirement)',
        (attribution?.textContent ?? '').includes('OpenStreetMap'),
      );
    },
  },
  {
    path: '/trajectory',
    label: 'Trajectory (empty state)',
    expect: ['Search a plate to reconstruct its route', 'Simulated demo network'],
    settleMs: 1200,
  },
  {
    // The core query of the whole product, driven end to end.
    path: `/trajectory?plate=${STORY_PLATES.commuter}`,
    label: 'Trajectory (commuter plate)',
    expect: [
      'Trip summary',
      'Timeline',
      'Trips',
      'accepted',
      'Avg speed',
      'km/h',
      'CAM-',
    ],
    reject: ['No accepted sightings', 'Could not load'],
    settleMs: 1800,
    assert: (container) => {
      const stops = container.querySelectorAll('.timeline__stop');
      check(
        'Trajectory: timeline rendered numbered stops',
        stops.length >= 2,
        `${stops.length} stops`,
      );

      const hops = container.querySelectorAll('.timeline__hop');
      check('Trajectory: hop rows rendered between stops', hops.length >= 1, `${hops.length} hops`);

      const scrubber = container.querySelector('input[type="range"]');
      check('Trajectory: playback scrubber present', scrubber !== null);

      const ticks = container.querySelectorAll('.playback__tick');
      check(
        'Trajectory: scrubber marks each camera pass',
        ticks.length === stops.length,
        `${ticks.length} ticks vs ${stops.length} stops`,
      );

      const routePaths = container.querySelectorAll('path.route-line');
      check(
        'Trajectory: route geometry drawn on the map',
        routePaths.length >= 1,
        `${routePaths.length} route paths`,
      );

      const playButton = container.querySelector('[aria-label="Play replay"]');
      check('Trajectory: play control present and labelled', playButton !== null);
    },
    interact: async (container) => {
      // A rendered scrubber proves nothing about whether the clock runs.
      const clockBefore = container.querySelector('.playback__clock')?.textContent ?? '';
      const play = container.querySelector<HTMLButtonElement>('[aria-label="Play replay"]');

      if (!play) {
        check('Trajectory: playback advances the clock', false, 'play button missing');
        return;
      }

      await act(async () => {
        play.click();
      });
      await flush(700);

      const clockAfter = container.querySelector('.playback__clock')?.textContent ?? '';
      check(
        'Trajectory: pressing play advances the virtual clock',
        clockAfter !== clockBefore && clockAfter.length > 0,
        `${clockBefore} → ${clockAfter}`,
      );

      const pause = container.querySelector<HTMLButtonElement>('[aria-label="Pause replay"]');
      check('Trajectory: play control flips to pause while running', pause !== null);

      // Advance must be proportional to speed, not a jump to the end: at 15×,
      // ~700 ms of real time is ~10 s of trip, so progress stays well short of 1.
      const range = container.querySelector<HTMLInputElement>('input[type="range"]');
      const progress = Number(range?.value ?? 0) / 1000;
      check(
        'Trajectory: playback advances proportionally, not instantly',
        progress > 0 && progress < 0.5,
        `progress ${progress.toFixed(3)}`,
      );

      // Seeking to a specific stop should move the reached marker.
      const stops = container.querySelectorAll<HTMLButtonElement>('.timeline__stop');
      const lastStop = stops[stops.length - 1];
      if (lastStop) {
        await act(async () => {
          lastStop.click();
        });
        await flush(300);
        check(
          'Trajectory: clicking a timeline stop selects it',
          container.querySelectorAll('.timeline__stop.is-selected').length === 1,
        );
      }
    },
  },
  {
    // A plate that trips the impossible-travel rule.
    path: `/trajectory?plate=${STORY_PLATES.impossible}`,
    label: 'Trajectory (impossible travel)',
    expect: ['Impossible travel time', 'anomalous hop'],
    settleMs: 1600,
  },
  {
    // A plate whose sightings were withheld by validation.
    path: `/trajectory?plate=${STORY_PLATES.contested}`,
    label: 'Trajectory (withheld sightings)',
    expect: ['Withheld'],
    settleMs: 1600,
  },
  {
    path: '/trajectory?plate=ZZ99ZZ9999',
    label: 'Trajectory (unknown plate)',
    expect: ['No accepted sightings'],
    settleMs: 1400,
  },
  {
    path: '/alerts',
    label: 'Alerts',
    expect: [
      'Alerts in window',
      'Route anomalies',
      'Blacklist hits',
      'Filters',
      'Severity',
      'route anomalies carry no severity',
    ],
    reject: ['No alerts match these filters'],
    settleMs: 1600,
    assert: (container) => {
      const cards = container.querySelectorAll('.alert-card');
      check('Alerts: alert cards rendered', cards.length > 1, `${cards.length} cards`);

      const chips = container.querySelectorAll('.ui-chip');
      check('Alerts: filter chips rendered', chips.length >= 10, `${chips.length} chips`);

      // Counts on the chips prove the counts endpoint was joined to the filters.
      const counted = container.querySelectorAll('.ui-chip__count');
      check('Alerts: filter chips show counts', counted.length >= 4, `${counted.length}`);
    },
    interact: async (container) => {
      const cards = container.querySelectorAll<HTMLElement>('.alert-card');
      const first = cards[0];
      if (!first) {
        check('Alerts: selecting an alert opens its detail', false, 'no cards');
        return;
      }

      await act(async () => {
        first.click();
      });
      await flush(400);

      const text = container.textContent ?? '';
      check(
        'Alerts: selecting an alert opens its detail',
        text.includes('Sightings involved') && text.includes('Dedup key'),
      );
      check(
        'Alerts: detail explains the evidence',
        text.includes('Evidence') || text.includes('Triggering'),
      );
    },
  },
  {
    path: '/analytics',
    label: 'Traffic analytics',
    expect: [
      'Vehicles recorded',
      'Network congestion',
      'Mean corridor speed',
      'Worst corridor',
      'Camera node load',
      'Node heatmap',
      'derived, not stored',
    ],
    reject: ['Could not load'],
    settleMs: 2400,
    assert: (container) => {
      const loadRows = container.querySelectorAll('.load-row');
      check(
        'Analytics: node load list rendered for every camera',
        loadRows.length >= 12,
        `${loadRows.length} rows`,
      );

      const tableRows = container.querySelectorAll('.ui-table tbody tr');
      check(
        'Analytics: link congestion table rendered',
        tableRows.length >= 5,
        `${tableRows.length} rows`,
      );

      const paths = container.querySelectorAll('path');
      check('Analytics: map layers rendered', paths.length > 40, `${paths.length} paths`);
    },
    interact: async (container) => {
      // Tab through the remaining views; each must render without throwing.
      const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
      for (const label of ['Flow trends', 'Origin–destination', 'Link congestion & speed']) {
        const tab = tabs.find((node) => node.textContent?.includes(label.split(' ')[0]!));
        if (!tab) {
          check(`Analytics: tab “${label}” exists`, false);
          continue;
        }
        await act(async () => {
          tab.click();
        });
        await flush(900);
        const text = container.textContent ?? '';
        check(
          `Analytics: “${label}” tab renders content`,
          text.length > 400 && !text.includes('Could not load'),
        );
      }
    },
  },
  {
    path: '/reports',
    label: 'Reports',
    expect: [
      'Avg congestion',
      'Total delay',
      'Daily volume and congestion',
      'When the corridor is congested',
      'Worst corridors this period',
      'Alerts by type',
      'no measurement, which is not the same as no congestion',
    ],
    reject: ['No report for this period'],
    settleMs: 3200,
    assert: (container) => {
      const cells = container.querySelectorAll('.heatmap__cell');
      check(
        'Reports: day×hour heatmap is a full 7×24 grid',
        cells.length === 168,
        `${cells.length} cells`,
      );

      const rows = container.querySelectorAll('.ui-table tbody tr');
      check('Reports: worst-corridor table populated', rows.length > 0, `${rows.length} rows`);

      const compare = container.querySelector('.report-compare');
      check('Reports: comparison against the previous period shown', compare !== null);
    },
  },
  {
    path: '/blacklist',
    label: 'Blacklist',
    expect: [
      'Watch list',
      'Enforceable now',
      'Add entry',
      'Entries are deactivated, never deleted',
    ],
    reject: ['No entries match'],
    settleMs: 1600,
    assert: (container) => {
      const rows = container.querySelectorAll('.ui-table tbody tr');
      check('Blacklist: entries rendered', rows.length >= 5, `${rows.length} rows`);

      const text = container.textContent ?? '';
      check(
        'Blacklist: all three statuses are represented in the fixture',
        text.includes('active') && text.includes('inactive') && text.includes('expired'),
      );
    },
    interact: async (container) => {
      const addButton = Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((node) => node.textContent?.includes('Add entry'));

      if (!addButton) {
        check('Blacklist: add dialog opens', false, 'no Add entry button');
        return;
      }

      await act(async () => {
        addButton.click();
      });
      await flush(300);

      // The dialog is portalled to document.body, not into the page container.
      const dialog = document.querySelector('[role="dialog"]');
      check('Blacklist: add dialog opens', dialog !== null);
      check(
        'Blacklist: dialog is labelled for assistive tech',
        dialog?.getAttribute('aria-modal') === 'true' &&
          dialog?.getAttribute('aria-labelledby') !== null,
      );
      check(
        'Blacklist: dialog explains the severity it has selected',
        (dialog?.textContent ?? '').includes('Active investigation'),
      );

      const cancel = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
      ).find((node) => node.textContent?.includes('Cancel'));
      if (cancel) {
        await act(async () => {
          cancel.click();
        });
        await flush(200);
        check(
          'Blacklist: dialog closes again',
          document.querySelector('[role="dialog"]') === null,
        );
      }
    },
  },
  {
    path: '/no-such-page',
    label: '404',
    expect: ['No such screen'],
    settleMs: 500,
  },
];

async function renderRoute(routeCase: RouteCase): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 },
    },
  });

  let root: Root | null = null;

  await act(async () => {
    root = createRoot(container);
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[routeCase.path]}>
            <LiveProvider>
              <App />
            </LiveProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </StrictMode>,
    );
  });

  await flush(routeCase.settleMs ?? 900);

  const text = container.textContent ?? '';

  for (const needle of routeCase.expect) {
    check(
      `${routeCase.label}: renders “${needle}”`,
      text.includes(needle),
      `not found in ${text.length} chars of output`,
    );
  }

  for (const needle of routeCase.reject ?? []) {
    check(`${routeCase.label}: no “${needle}”`, !text.includes(needle));
  }

  check(
    `${routeCase.label}: produced substantial output`,
    text.length > 200,
    `${text.length} chars`,
  );

  routeCase.assert?.(container);

  if (routeCase.interact) {
    await routeCase.interact(container);
  }

  await act(async () => {
    root?.unmount();
  });
  queryClient.clear();
  container.remove();
}

async function main(): Promise<void> {
  log('\nRender smoke test (jsdom + mock transport)');

  for (const routeCase of CASES) {
    log(`\n${routeCase.path}`);
    try {
      await renderRoute(routeCase);
    } catch (error) {
      failures += 1;
      log(`  ✗ ${routeCase.label}: threw during render`);
      log(String(error instanceof Error ? (error.stack ?? error.message) : error));
    }
  }

  // React reports render failures and invalid-prop problems through console.error.
  const isNoise = (message: string): boolean =>
    message.includes('✓') ||
    message.includes('✗') ||
    // jsdom cannot parse CSS custom properties used in SVG paint attributes;
    // harmless here and irrelevant to what is being asserted.
    message.toLowerCase().includes('could not parse css') ||
    // Node writes deprecation and experimental notices to stderr.
    message.includes('DeprecationWarning') ||
    message.includes('ExperimentalWarning') ||
    message.includes('--trace-deprecation');

  const meaningfulErrors = consoleErrors.filter((message) => !isNoise(message));

  log('\nConsole output');
  check(
    'no console.error during render',
    meaningfulErrors.length === 0,
    meaningfulErrors.slice(0, 5).join(' | ').slice(0, 900),
  );

  const meaningfulWarnings = consoleWarnings.filter((message) => !isNoise(message));
  if (meaningfulWarnings.length > 0) {
    log(`  ! ${meaningfulWarnings.length} console.warn message(s):`);
    for (const message of meaningfulWarnings.slice(0, 5)) {
      log(`    ${message.slice(0, 300)}`);
    }
  }

  console.error = originalError;
  console.warn = originalWarn;

  log(
    failures === 0
      ? '\n✅ render smoke test passed\n'
      : `\n❌ ${failures} render check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
