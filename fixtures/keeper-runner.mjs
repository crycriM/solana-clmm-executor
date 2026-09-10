// Test-only entrypoint: all transport/startup code is the built real executor.
// State injection stays here; the production CLI gains no test verbs or flags.
import fs from 'node:fs';
import { main } from '../dist/bridge.js';
import { createStubHandlers } from '../dist/handlers.js';
import { errorResponse } from '../dist/protocol.js';

const handlers = createStubHandlers();
const original = handlers.get_state;
handlers.get_state = async (request) => {
  const scenario = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (scenario.ok === false) return errorResponse('rpc_timeout', 'Injected offline read failure');
  const response = await original(request);
  response.data = { ...response.data, ...scenario.state };
  return response;
};
process.exitCode = await main(handlers);
