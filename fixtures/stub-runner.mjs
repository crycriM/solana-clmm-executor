// Offline-only entrypoint. Production `dist/bridge.js` always wires M2 live
// reads; contract tests inject the deterministic M1 handlers explicitly.
import { main } from '../dist/bridge.js';
import { createStubHandlers } from '../dist/handlers.js';

process.exitCode = await main(createStubHandlers());
