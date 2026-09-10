/** Shared offline request fixtures; no test suite imports another suite. */
import fs from 'node:fs';
import type { ExecRequest, Verb } from '../../src/protocol.js';

export const requestsByVerb = JSON.parse(
  fs.readFileSync(new URL('../../fixtures/requests.json', import.meta.url), 'utf8'),
) as Record<Verb, ExecRequest>;

export const verbs = Object.keys(requestsByVerb) as Verb[];
