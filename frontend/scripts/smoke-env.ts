/**
 * jsdom environment for the render smoke test.
 *
 * Must be imported *before* anything that touches the DOM: Leaflet reads
 * `window` and `document` at module-evaluation time, so the globals have to exist
 * before its import is even resolved.
 *
 * Also polyfills the two browser APIs jsdom lacks that this app genuinely relies
 * on — `ResizeObserver` (Leaflet resize handling and Recharts' responsive
 * container) and `matchMedia`.
 */

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5173/',
  pretendToBeVisual: true,
});

const { window } = dom;

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

interface Globals {
  window: unknown;
  document: unknown;
  HTMLElement: unknown;
  SVGElement: unknown;
  Element: unknown;
  Node: unknown;
  Event: unknown;
  MouseEvent: unknown;
  KeyboardEvent: unknown;
  CustomEvent: unknown;
  getComputedStyle: unknown;
  requestAnimationFrame: unknown;
  cancelAnimationFrame: unknown;
  ResizeObserver: unknown;
  matchMedia: unknown;
  localStorage: unknown;
  WebSocket: unknown;
}

const target = globalThis as unknown as Globals;

target.window = window;
target.document = window.document;
// Node 21+ defines a getter-only global `navigator`, so it has to be redefined
// rather than assigned.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  get: () => window.navigator,
});
target.HTMLElement = window.HTMLElement;
target.SVGElement = window.SVGElement;
target.Element = window.Element;
target.Node = window.Node;
target.Event = window.Event;
target.MouseEvent = window.MouseEvent;
target.KeyboardEvent = window.KeyboardEvent;
target.CustomEvent = window.CustomEvent;
target.getComputedStyle = window.getComputedStyle.bind(window);
// The callback must receive a DOMHighResTimeStamp (a `performance.now()` value),
// not an epoch time. Anything that measures frame deltas would otherwise see a
// first delta of ~1.7e12 ms and jump straight to the end of its animation.
target.requestAnimationFrame = (cb: (t: number) => void) =>
  setTimeout(() => cb(performance.now()), 16) as unknown as number;
target.cancelAnimationFrame = (id: number) => clearTimeout(id);
target.ResizeObserver = ResizeObserverStub;
target.localStorage = window.localStorage;
target.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});

// The dashboard runs in mock mode here, so no real socket is opened. A stub keeps
// the module from throwing if that ever changes.
target.WebSocket = class WebSocketStub {
  static readonly OPEN = 1;
  readyState = 1;
  close(): void {}
  send(): void {}
};

(window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

/**
 * Leaflet sizes itself from the container's client rect, which jsdom always
 * reports as 0×0. Without a size the map computes an empty viewport and skips
 * layer rendering, so a fixed viewport is faked for the test.
 */
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get() {
    return 1280;
  },
});
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get() {
    return 800;
  },
});
// jsdom implements no scrolling, so these are no-ops rather than missing methods.
window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
window.HTMLElement.prototype.scrollTo = function scrollTo() {};

window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return {
    x: 0,
    y: 0,
    width: 1280,
    height: 800,
    top: 0,
    left: 0,
    right: 1280,
    bottom: 800,
    toJSON: () => ({}),
  } as DOMRect;
};

export { dom, window as jsdomWindow };
