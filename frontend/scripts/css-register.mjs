/**
 * Stubs CSS imports so the components can be imported outside Vite.
 *
 * Vite treats `import './x.css'` as a side-effecting asset import; Node has no
 * idea what a `.css` file is and refuses to load it. The render smoke test runs
 * the real components without Vite, so CSS resolves to an empty module — styling
 * is not what that test checks.
 *
 * Uses `registerHooks` (synchronous, in-thread) rather than the deprecated
 * `register`, which emits a DeprecationWarning on stderr.
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url.endsWith('.css')) {
      return { ...resolved, format: 'module', shortCircuit: true };
    }
    return resolved;
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export default {};', shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
