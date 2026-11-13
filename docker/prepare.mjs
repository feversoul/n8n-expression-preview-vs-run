// Used by bootstrap.sh inside the n8n container: copies the workflow files
// into one folder, named by workflow id, for `n8n import:workflow --separate`.
//   node prepare.mjs <output dir> <workflows dir>...
//
// Optional environment:
//   STANDIN_URL   replaces http://standin:8080 in the HTTP nodes

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [out, ...sources] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

for (const source of sources) {
  for (const file of readdirSync(source).filter((name) => name.endsWith('.json'))) {
    let text = readFileSync(join(source, file), 'utf8');
    if (process.env.STANDIN_URL) text = text.replaceAll('http://standin:8080', process.env.STANDIN_URL);
    const workflow = JSON.parse(text);
    writeFileSync(join(out, `${workflow.id}.json`), JSON.stringify(workflow));
  }
}
