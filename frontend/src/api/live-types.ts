/**
 * Live-feed interface, in its own module so importing the *type* never drags in an
 * implementation. The mock emitter depends on the whole fixture layer, and a value
 * import of it from `live.ts` would pull thousands of generated rows into the entry
 * chunk even when the app is configured for the real API.
 */

import type { ConnectionState, LiveMessage } from '@/types/api';

export interface LiveConnection {
  getState(): ConnectionState;
  onMessage(listener: (message: LiveMessage) => void): () => void;
  onState(listener: (state: ConnectionState) => void): () => void;
  close(): void;
}
