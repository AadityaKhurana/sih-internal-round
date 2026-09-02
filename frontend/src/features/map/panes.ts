/**
 * Custom Leaflet pane names and their stacking order.
 *
 * Leaflet's built-in panes are tile 200, overlay 400, shadow 500, marker 600,
 * tooltip 650, popup 700. Everything below sits between the overlay and marker
 * panes so that camera markers and popups always stay clickable above the
 * corridor geometry, and a highlighted route always draws above the base network
 * instead of disappearing under it.
 */

export const MAP_PANES = {
  /** Base directed camera links. */
  links: { name: 'anpr-links', zIndex: 410 },
  /** Links being emphasised (selected corridor, congestion overlay). */
  linksTop: { name: 'anpr-links-top', zIndex: 418 },
  /** Trajectory route geometry. */
  route: { name: 'anpr-route', zIndex: 425 },
  /** Route decoration: direction arrows, anomaly markers. */
  routeTop: { name: 'anpr-route-top', zIndex: 432 },
  /** Camera nodes. */
  cameras: { name: 'anpr-cameras', zIndex: 440 },
  /** Live activity pulses, drawn under the nodes so they read as a halo. */
  pulses: { name: 'anpr-pulses', zIndex: 436 },
} as const;

export type MapPaneKey = keyof typeof MAP_PANES;
