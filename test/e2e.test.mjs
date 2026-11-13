// End-to-end tests: every case workflow on a real n8n (test/stack.sh or
// npm run test:e2e). Each test starts a run over the production webhook, or a
// manual run the way the editor's "Execute workflow" button does, and asserts
// what the Edit Fields node actually returned.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.N8N_URL ?? 'http://localhost:55692';
const LABEL = process.env.LABEL ?? 'n8n 2.46.7, expression engine vm';
const OWNER = { email: 'owner@example.com', firstName: 'Lab', lastName: 'Owner', password: 'Lab-owner-1234' };

// The message from the thread's screenshot.
const M = 'error:1C80006B:Provider routines::wrong final block length';
// A Code node that throws adds the line number to the message.
const M_CODE = `${M} [line 2]`;
const FAILED = 'PROCESSOR_REQUEST_FAILED';
const NOT_EXECUTED = "Node 'start' hasn't been executed";
const INVALID_JSON = "The 'JSON Output' in item 0 contains invalid JSON";

const ok = (id = 1) => ({ id });
const fail = (id = 1, message = M) => ({ id, fail: message });

let apiKey = '';
let cookie = '';
const report = [];
const note = (name, input, result) => report.push({ name, input, result });
const show = (value) => (value === undefined ? 'undefined' : JSON.stringify(value));

const json = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
};

async function until(check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(500);
  }
}

const api = async (path) => json(await fetch(`${BASE}/api/v1${path}`, { headers: { 'x-n8n-api-key': apiKey } }));
const rest = async (method, path, body) => {
  const response = await fetch(`${BASE}/rest${path}`, {
    method,
    headers: { cookie, 'browser-id': 'lab', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await json(response), headers: response.headers };
};

// What one execution did: per node, per run, the json of the items on each
// output. `error` is the message the execution failed with, if it failed.
function read(execution) {
  const result = execution.data.resultData;
  const nodes = {};
  for (const [name, runs] of Object.entries(result.runData)) {
    nodes[name] = runs.map((run) => (run.data?.main ?? []).map((output) => (output ?? []).map((item) => item.json)));
  }
  return { id: execution.id, status: execution.status, mode: execution.mode, error: result.error?.message, nodes };
}

const seen = new Map();
// A production run: POST to the webhook of a case. The webhook answers with
// the items of the last node; the execution is read back as well.
async function run(name, body) {
  const response = await fetch(`${BASE}/webhook/exprlab/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const answer = await json(response);
  const execution = await until(async () => {
    const newest = (await api(`/executions?workflowId=exprlab-${name}&limit=1&includeData=true`)).data?.[0];
    return newest && newest.stoppedAt && Number(newest.id) > (seen.get(name) ?? 0) ? newest : null;
  });
  seen.set(name, Number(execution.id));
  return { http: response.status, answer, ...read(execution) };
}

// A manual run, the request the editor sends for "Execute workflow". Pinned
// data is part of the workflow, as it is in the editor.
async function runManually(name, trigger) {
  const workflow = (await rest('GET', `/workflows/exprlab-${name}`)).body.data;
  const started = await rest('POST', `/workflows/exprlab-${name}/run`, { workflowData: workflow, triggerToStartFrom: { name: trigger } });
  assert.equal(started.status, 200, JSON.stringify(started.body).slice(0, 300));
  const execution = await until(async () => {
    const found = await api(`/executions/${started.body.data.executionId}?includeData=true`);
    return found.stoppedAt ? found : null;
  });
  seen.set(name, Math.max(seen.get(name) ?? 0, Number(execution.id)));
  return read(execution);
}

// "msg" of every item Edit Fields returned, all runs in order.
const msgs = (result, node = 'Edit Fields') => (result.nodes[node] ?? []).flatMap((outputs) => (outputs[0] ?? []).map((item) => item.msg));

before(async () => {
  // bootstrap.sh publishes every workflow before n8n starts.
  await until(async () => (await fetch(`${BASE}/webhook/exprlab/11-unquoted-in-json-fixed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 200, 600_000);

  // Owner and API key through n8n's own endpoints, the ones the first-run
  // screen and Settings > n8n API use.
  // The webhooks can answer a moment before the editor's API does.
  const response = await until(async () => {
    let attempt = await rest('POST', '/owner/setup', OWNER);
    if (attempt.status !== 200) attempt = await rest('POST', '/login', { emailOrLdapLoginId: OWNER.email, password: OWNER.password });
    return attempt.status === 200 ? attempt : null;
  }, 60_000);
  cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const key = await rest('POST', '/api-keys', { label: `lab-${Date.now().toString(36)}`, expiresAt: null, scopes: ['execution:read', 'execution:list', 'workflow:read', 'workflow:list'] });
  assert.equal(key.status, 200, JSON.stringify(key.body).slice(0, 300));
  apiKey = key.body.data.rawApiKey;
});

after(() => {
  const width = Math.max(...report.map((line) => line.name.length));
  const inputWidth = Math.max(...report.map((line) => line.input.length));
  console.log(`\nWhat Edit Fields returned as "msg" (${LABEL}).\n`);
  for (const line of report) console.log(`  ${line.name.padEnd(width)}  ${line.input.padEnd(inputWidth)}  ${line.result}`);
  console.log('');
});

// --- 01 the run did not produce the error --------------------------------------

test('01 start failed in this run: msg is the message, like the preview', async () => {
  const result = await run('01-no-error-this-run-broken', { items: [fail()] });
  assert.equal(result.http, 200);
  assert.deepEqual(result.answer, [{ e_event: FAILED, msg: M }]);
  note('01 no error this run, broken', 'start fails', show(result.answer[0].msg));
});

test('01 start did not fail in this run: msg is null, the node does not fail', async () => {
  const result = await run('01-no-error-this-run-broken', { items: [ok()] });
  assert.equal(result.http, 200);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.nodes.start[0][0], [{ id: 1, status: 'processed' }], 'start returned an item without "error"');
  assert.deepEqual(result.answer, [{ e_event: FAILED, msg: null }]);
  note('01 no error this run, broken', 'start succeeds', show(result.answer[0].msg));
});

test('01 fixed: the failure event is only built when start failed', async () => {
  const failed = await run('01-no-error-this-run-fixed', { items: [ok(1), fail(2), ok(3)] });
  assert.deepEqual([...new Set(msgs(failed))], [M]);
  const fine = await run('01-no-error-this-run-fixed', { items: [ok()] });
  assert.equal(fine.nodes['Edit Fields'], undefined, 'Edit Fields did not run');
  assert.deepEqual(fine.answer, [{ id: 1, status: 'processed' }]);
  note('01 no error this run, fixed', 'start fails', show(msgs(failed)[0]));
  note('01 no error this run, fixed', 'start succeeds', 'Edit Fields does not run');
});

// --- 02 / 03 pinned data ---------------------------------------------------------

test('02 start is pinned with a failed result: a manual run uses the pin, a production run does not', async () => {
  const manual = await runManually('02-pinned-node', 'Manual');
  assert.equal(manual.mode, 'manual');
  assert.deepEqual(manual.nodes.start[0][0], [{ error: M }], 'the pinned item');
  assert.deepEqual(msgs(manual), [M]);

  const production = await run('02-pinned-node', {});
  assert.equal(production.mode, 'webhook');
  assert.deepEqual(production.nodes.start[0][0], [{ id: 1, status: 'processed' }], 'start really ran');
  assert.deepEqual(production.answer, [{ e_event: FAILED, msg: null }]);
  note('02 start pinned with { error }', 'manual run', show(msgs(manual)[0]));
  note('02 start pinned with { error }', 'production run', show(production.answer[0].msg));
});

test('03 start is a trigger pinned with { error }: the live webhook puts it under body', async () => {
  const manual = await runManually('03-pinned-trigger-shape-broken', 'start');
  assert.deepEqual(msgs(manual), [M]);

  const production = await run('03-pinned-trigger-shape-broken', { error: M });
  assert.equal(production.nodes.start[0][0][0].body.error, M, 'the live item has body.error');
  assert.equal(production.nodes.start[0][0][0].error, undefined, 'and no error at the top');
  assert.deepEqual(production.answer, [{ e_event: FAILED, msg: null }]);

  const fixed = await run('03-pinned-trigger-shape-fixed', { error: M });
  assert.deepEqual(fixed.answer, [{ e_event: FAILED, msg: M }]);
  note('03 trigger pinned with { error }, broken', 'manual run', show(msgs(manual)[0]));
  note('03 trigger pinned with { error }, broken', 'production run', show(production.answer[0].msg));
  note('03 trigger pinned with { error }, fixed', 'production run', show(fixed.answer[0].msg));
});

// --- 04 error output ---------------------------------------------------------------

test('04 Edit Fields on the error output: all() reads the error output, msg is the message', async () => {
  const result = await run('04-error-output', { items: [fail()] });
  assert.deepEqual(result.nodes.start[0], [[], [{ id: 1, fail: M, error: M_CODE }]], 'nothing on the success output, the item plus "error" on the error output');
  assert.deepEqual(result.answer, [{ e_event: FAILED, msg: M_CODE }]);
  note('04 error output', 'start fails', show(result.answer[0].msg));
});

test('04 both outputs lead to Edit Fields: all() still reads the error output when it has items', async () => {
  const mixed = await run('04-error-output-both-wired', { items: [ok(1), fail(2), ok(3)] });
  assert.equal(mixed.nodes['Edit Fields'].length, 2, 'Edit Fields ran once per output');
  assert.deepEqual(msgs(mixed), [M_CODE, M_CODE, M_CODE]);
  const fine = await run('04-error-output-both-wired', { items: [ok()] });
  assert.equal(fine.error, undefined);
  assert.deepEqual(msgs(fine), [null]);
  note('04 both outputs wired', 'item 2 of 3 fails', show(msgs(mixed)));
  note('04 both outputs wired', 'nothing fails', show(msgs(fine)));
});

// --- 05 several items --------------------------------------------------------------

test('05 the failed item is not the first: all()[0] is null for every item', async () => {
  const result = await run('05-failed-item-not-first-broken', { items: [ok(1), fail(2), ok(3)] });
  assert.deepEqual(result.nodes.start[0][0], [{ id: 1, status: 'processed' }, { error: M }, { id: 3, status: 'processed' }]);
  assert.deepEqual(msgs(result), [null, null, null]);
  const fixed = await run('05-failed-item-not-first-fixed', { items: [ok(1), fail(2), ok(3)] });
  assert.deepEqual(msgs(fixed), [null, M, null]);
  note('05 failed item not first, broken', 'item 2 of 3 fails', show(msgs(result)));
  note('05 failed item not first, fixed (.item)', 'item 2 of 3 fails', show(msgs(fixed)));
});

// --- 06 loops ----------------------------------------------------------------------

test('06 start in a loop, Edit Fields after it: all() is the last run of start only', async () => {
  const first = await run('06-loop-last-run-broken', { items: [fail(1), ok(2), ok(3)] });
  assert.equal(first.nodes.start.length, 3, 'start ran three times');
  assert.deepEqual(first.nodes.start[0][0], [{ error: M }], 'and failed in the first run');
  assert.deepEqual(msgs(first), [null, null, null]);
  const last = await run('06-loop-last-run-broken', { items: [ok(1), ok(2), fail(3)] });
  assert.deepEqual(msgs(last), [M, M, M]);
  const fixed = await run('06-loop-last-run-fixed', { items: [fail(1), ok(2), ok(3)] });
  assert.deepEqual(msgs(fixed), [M]);
  note('06 loop, Edit Fields after it, broken', 'item 1 of 3 fails', show(msgs(first)));
  note('06 loop, Edit Fields after it, broken', 'item 3 of 3 fails', show(msgs(last)));
  note('06 loop, Edit Fields after it, fixed', 'item 1 of 3 fails', show(msgs(fixed)));
});

test('06 Edit Fields inside the loop: one run per item, only the run of the failed item has the message', async () => {
  const result = await run('06-inside-loop', { items: [fail(1), ok(2), ok(3)] });
  assert.equal(result.nodes['Edit Fields'].length, 3);
  assert.deepEqual(msgs(result), [M, null, null]);
  note('06 Edit Fields inside the loop', 'item 1 of 3 fails', `${show(msgs(result))} (runs 1, 2, 3)`);
});

// --- 07 start not executed -----------------------------------------------------------

test('07 start on another branch that runs later: the run fails, it does not give null', async () => {
  for (const name of ['07-other-branch-v1', '07-other-branch-v0']) {
    const result = await run(name, { items: [fail()] });
    assert.equal(result.http, 500);
    assert.equal(result.error, NOT_EXECUTED);
    assert.equal(result.nodes.start, undefined, 'start had not run yet');
    note(`07 start on a later branch (${name.slice(-2)})`, 'start fails', `run fails: ${result.error}`);
  }
  const swapped = await run('07-other-branch-v1-swapped', { items: [fail()] });
  assert.deepEqual(msgs(swapped), [M]);
  note('07 start on an earlier branch (v1)', 'start fails', show(msgs(swapped)[0]));
});

test('07 start behind an IF this run did not take: the run fails, it does not give null', async () => {
  const result = await run('07-not-on-path', { items: [fail()] });
  assert.equal(result.http, 500);
  assert.equal(result.error, NOT_EXECUTED);
  const taken = await run('07-not-on-path', { items: [{ ...fail(), use_start: true }] });
  assert.deepEqual(msgs(taken), [M]);
  note('07 start behind an IF not taken', 'start fails', `run fails: ${result.error}`);
});

// --- 08 where the error lives --------------------------------------------------------

test('08 where "error" lives for each way of failing', async () => {
  const item = async (name) => (await run(name, { items: [fail()] })).answer[0].msg;

  const codeRegular = await item('08-shape-code-regular');
  assert.deepEqual(codeRegular, { error: M_CODE });

  const codeErrorOutput = await item('08-shape-code-error-output');
  assert.deepEqual(codeErrorOutput, { id: 1, fail: M, error: M_CODE });

  const httpRegular = await item('08-shape-http-regular');
  assert.deepEqual(Object.keys(httpRegular), ['error']);
  assert.equal(typeof httpRegular.error, 'object');
  assert.equal(httpRegular.error.status, 500);
  assert.ok(httpRegular.error.message.includes(M));

  const httpErrorOutput = await item('08-shape-http-error-output');
  assert.equal(httpErrorOutput.id, 1);
  assert.equal(typeof httpErrorOutput.error, 'object');
  assert.ok(httpErrorOutput.error.message.includes(M));

  const neverError = await item('08-shape-http-never-error');
  assert.equal(neverError.error, undefined);
  assert.equal(neverError.statusCode, 500);
  assert.deepEqual(neverError.body, { message: M });

  const inBody = await item('08-shape-http-error-in-body');
  assert.deepEqual(inBody, { id: 1, error: { code: FAILED, message: M } });

  const short = (value) =>
    show(value)
      .replace(/"stack":"[^"]*"/, '"stack":"..."')
      .slice(0, 150);
  note('08 Code throws, Continue', 'json of start', short(codeRegular));
  note('08 Code throws, error output', 'json of start', short(codeErrorOutput));
  note('08 HTTP 500, Continue', 'json of start', short({ error: { message: httpRegular.error.message, name: httpRegular.error.name, status: httpRegular.error.status, '...': '' } }));
  note('08 HTTP 500, error output', 'json of start', `{"id":1,"fail":"...","error":{"message":...,"status":500,...}}`);
  note('08 HTTP 500, Never Error + full response', 'json of start', short({ statusCode: neverError.statusCode, body: neverError.body, '...': '' }));
  note('08 HTTP 200 with error in the body', 'json of start', short(inBody));
});

// --- 09 field type in manual mapping -------------------------------------------------

test('09 the field type: a missing value is null for every type, a wrong type fails the run', async () => {
  const asString = { items: [fail()] };
  const asObject = { items: [{ ...fail(), as_object: true }] };
  const none = { items: [ok()] };
  const msg = async (name, body) => {
    const result = await run(name, body);
    return result.http === 200 ? result.answer[0].msg : `run fails: ${result.error}`;
  };

  assert.equal(await msg('09-type-string', asString), M);
  assert.equal(await msg('09-type-string', asObject), JSON.stringify({ message: M }));
  assert.equal(await msg('09-type-string', none), null);

  const wrong = await msg('09-type-object', asString);
  assert.equal(wrong, `run fails: 'msg' expects a object but we got '${M}' [item 0]`);
  assert.deepEqual(await msg('09-type-object', asObject), { message: M });
  assert.equal(await msg('09-type-object', none), null);

  assert.equal(await msg('09-type-object-ignore', asString), M);
  assert.equal(await msg('09-type-object-ignore', none), null);

  note('09 manual, String field', 'error is a string', show(M));
  note('09 manual, String field', 'error is an object', show(JSON.stringify({ message: M })));
  note('09 manual, String field', 'no error', 'null');
  note('09 manual, Object field', 'error is a string', wrong);
  note('09 manual, Object field', 'error is an object', show({ message: M }));
  note('09 manual, Object field', 'no error', 'null');
  note('09 manual, Object field, ignore type errors', 'error is a string', show(M));
});

// --- 10 include other input fields ---------------------------------------------------

test('10 Include Other Input Fields does not change msg', async () => {
  const fine = await run('10-include-other-fields', { items: [ok()] });
  assert.deepEqual(fine.answer, [{ id: 1, status: 'processed', e_event: FAILED, msg: null }]);
  const failed = await run('10-include-other-fields', { items: [fail()] });
  assert.deepEqual(failed.answer, [{ error: M, e_event: FAILED, msg: M }]);
  note('10 Include Other Input Fields', 'start succeeds', show(fine.answer[0].msg));
  note('10 Include Other Input Fields', 'start fails', show(failed.answer[0].msg));
});

// --- 11 the value has no quotes in the JSON --------------------------------------------

const messages = [M, 'He said "no"', 'bad block [line 2]', 'timeout, then reset', 'true', '42'];

test('11 JSON mode without quotes: some messages survive, some fail the node, some change type', async () => {
  const expected = [M, null, null, null, true, 42];
  for (const [index, message] of messages.entries()) {
    const result = await run('11-unquoted-in-json-broken', { items: [fail(1, message)] });
    if (expected[index] === null) {
      assert.equal(result.http, 500, message);
      assert.equal(result.error, INVALID_JSON);
      note('11 no quotes in the JSON, broken', `error is ${show(message)}`, `run fails: ${result.error}`);
    } else {
      assert.deepEqual(result.answer, [{ e_event: FAILED, msg: expected[index] }], message);
      note('11 no quotes in the JSON, broken', `error is ${show(message)}`, show(result.answer[0].msg));
    }
  }
});

test('11 fixed with JSON.stringify: every message arrives as the same string, a missing one as null', async () => {
  for (const message of messages) {
    const result = await run('11-unquoted-in-json-fixed', { items: [fail(1, message)] });
    assert.deepEqual(result.answer, [{ e_event: FAILED, msg: message }], message);
  }
  const none = await run('11-unquoted-in-json-fixed', { items: [ok()] });
  assert.deepEqual(none.answer, [{ e_event: FAILED, msg: null }]);
  note('11 no quotes in the JSON, fixed', 'all six messages', 'the same string each time');
  note('11 no quotes in the JSON, fixed', 'no error', 'null');
});
