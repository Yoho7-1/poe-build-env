// Worker thread of the analysis batch pool (analysis-engine.mjs childMain). Each job is exactly what
// `agent.mjs pob run <file> --scenario S --changes C --out O [--full]` does (same runPob call, same --out JSON,
// same error JSON on failure), but pob.mjs is loaded once per thread instead of once per calculation, so cached
// calculations cost milliseconds instead of a Node start. The calculation contract and the cache are unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { readJson, atomicJson } from './workspace.mjs';
import { runPob } from './pob.mjs';

parentPort.on('message', async ({ id, file, scenario, changesFile, outFile, errFile, full }) => {
  try {
    const result = runPob({ input: fs.readFileSync(path.resolve(file)), scenario: scenario ?? 'imported', changes: readJson(path.resolve(changesFile)), saveXml: null, full: !!full, migrate: false });
    atomicJson(path.resolve(outFile), result);
  } catch (error) {
    const { errorCode } = await import('./agent.mjs');
    fs.writeFileSync(errFile, JSON.stringify({ error: error.message, code: errorCode(error.message) }) + '\n');
  }
  parentPort.postMessage({ id });
});
