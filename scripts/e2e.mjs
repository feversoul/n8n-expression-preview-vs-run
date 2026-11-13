// npm run test:e2e
// Starts the test stack, runs test/e2e.test.mjs against it and removes the
// stack again. Set KEEP_STACK=1 to leave it running, for example to open the
// n8n editor on http://localhost:55692 and look at the executions.
//
//   N8N_IMAGE=n8nio/n8n:2.47.7 npm run test:e2e      another n8n version
//   N8N_EXPRESSION_ENGINE=legacy npm run test:e2e    the older expression engine

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compose = ['compose', '--env-file', 'test/test.env', '-f', 'docker-compose.yml', '-f', 'test/docker-compose.yml', '-p', 'exprlab-test'];
const image = process.env.N8N_IMAGE ?? 'n8nio/n8n:2.46.7';
const env = { ...process.env, LABEL: process.env.LABEL ?? `n8n ${image.split(':')[1]}, expression engine ${process.env.N8N_EXPRESSION_ENGINE ?? 'vm'}` };
const run = (command, args) => spawnSync(command, args, { cwd: root, stdio: 'inherit', env }).status ?? 1;

run('docker', [...compose, 'down', '-v']);
let status = run('docker', [...compose, 'up', '-d']);
if (status === 0) status = run(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', 'test/e2e.test.mjs']);
if (status !== 0) run('docker', [...compose, 'logs', '--tail', '60', 'n8n']);
if (!process.env.KEEP_STACK) run('docker', [...compose, 'down', '-v']);
process.exit(status);
