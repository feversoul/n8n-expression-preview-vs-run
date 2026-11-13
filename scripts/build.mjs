// node scripts/build.mjs
// Writes workflows/*.json: one small workflow per case, broken and fixed.
// Every workflow is: Webhook -> Items -> (the case) -> Edit Fields.
//
//   Edit Fields   JSON mode, the way the thread's screenshot shows it:
//                 { "e_event": "...", "msg": {{ <expression> }} }
//                 (case 09 uses manual mapping to compare the field types)
//
// The webhook answers with the items of the last node, so a test (or curl)
// reads the executed output directly. PROBE=1 adds a node that prints what
// $('start') returns in several spellings; it was used to explore, the
// committed workflows are built without it.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
const PROBE = Boolean(process.env.PROBE);

// The expression from the thread.
const AUTHOR = "$('start').all()[0].json.error";
// The message from the thread's screenshot.
export const MESSAGE = 'error:1C80006B:Provider routines::wrong final block length';

// --- nodes -----------------------------------------------------------------

let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

const webhook = (path, name = 'Webhook') => ({
  name,
  type: 'n8n-nodes-base.webhook',
  typeVersion: 2,
  webhookId: `exprlab-${path}`,
  parameters: { httpMethod: 'POST', path: `exprlab/${path}`, responseMode: 'lastNode', responseData: 'allEntries', options: {} },
});

// One item per entry of body.items, e.g. [{ "id": 1, "fail": "some message" }].
const items = (source = 'Webhook') => ({
  name: 'Items',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  parameters: { jsCode: `return ($('${source}').first().json.body.items ?? [{ id: 1 }]).map((json) => ({ json }));` },
});

// The failing step as a Code node: throws when the item has "fail".
const codeStart = (onError, name = 'start') => ({
  name,
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  ...(onError ? { onError } : {}),
  parameters: {
    mode: 'runOnceForEachItem',
    jsCode: ['// Stands in for the step that fails (a decrypt step in the thread).', 'if ($json.fail) throw new Error($json.fail);', "return { json: { id: $json.id, status: 'processed' } };"].join(
      '\n',
    ),
  },
});

// The failing step as a Code node that catches its own error and returns
// { error: "<message>" }: a plain string, like the one in the thread.
const softStart = () => ({
  name: 'start',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  parameters: {
    mode: 'runOnceForEachItem',
    jsCode: [
      '// Stands in for the step that fails (a decrypt step in the thread).',
      'if ($json.fail) return { json: { error: $json.fail } };',
      "return { json: { id: $json.id, status: 'processed' } };",
    ].join('\n'),
  },
});

// The failing step as an HTTP Request to the stand-in.
const httpStart = (onError, path = 'processor', options = {}) => ({
  name: 'start',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  ...(onError ? { onError } : {}),
  parameters: { method: 'POST', url: `http://standin:8080/${path}`, sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify({ id: $json.id, fail: $json.fail ?? "" }) }}', options },
});

const editJson = (expression = AUTHOR, { name = 'Edit Fields', include = false } = {}) => ({
  name,
  type: 'n8n-nodes-base.set',
  typeVersion: 3.4,
  parameters: {
    mode: 'raw',
    jsonOutput: `={\n  "e_event": "PROCESSOR_REQUEST_FAILED",\n  "msg": {{ ${expression} }}\n}`,
    ...(include ? { includeOtherFields: true } : {}),
    options: {},
  },
});

const editManual = (expression = AUTHOR, { name = 'Edit Fields (manual)', type = 'string', field = 'msg_manual', options = {} } = {}) => ({
  name,
  type: 'n8n-nodes-base.set',
  typeVersion: 3.4,
  parameters: {
    mode: 'manual',
    assignments: { assignments: [{ id: uid(), name: field, value: `={{ ${expression} }}`, type }] },
    includeOtherFields: true,
    options,
  },
});

const noOp = (name) => ({ name, type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} });

const ifNode = (name, expression) => ({
  name,
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: uid(), leftValue: `={{ ${expression} }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and',
    },
    looseTypeValidation: true,
    options: {},
  },
});

const loop = () => ({ name: 'Loop Over Items', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, parameters: { options: {} } });

const probe = () => {
  const tryIt = (code) => `(() => { try { return JSON.stringify(${code}) ?? 'undefined'; } catch (e) { return 'THROWS ' + e.message; } })()`;
  const fields = {
    author: AUTHOR,
    count: "$('start').all().length",
    all: "$('start').all().map((i) => i.json)",
    all_out1: "$('start').all(1).map((i) => i.json)",
    all_run0: "$('start').all(0, 0).map((i) => i.json)",
    first: "$('start').first().json",
    last: "$('start').last().json",
    item: "$('start').item.json",
    json: '$json',
    executed: "$('start').isExecuted",
    run: '$runIndex',
  };
  return {
    name: 'Probe',
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    parameters: {
      mode: 'manual',
      assignments: { assignments: Object.entries(fields).map(([name, code]) => ({ id: uid(), name: `probe_${name}`, value: `={{ ${tryIt(code)} }}`, type: 'string' })) },
      includeOtherFields: false,
      options: {},
    },
  };
};

// --- workflow --------------------------------------------------------------

// links: [from, to] or [from, to, output index of from]
function workflow(id, title, nodes, links, { settings = {}, pinData, probeFrom } = {}) {
  if (PROBE && probeFrom) {
    nodes = [...nodes, probe()];
    links = [...links, [...probeFrom.slice(0, 1), 'Probe', probeFrom[1] ?? 0]];
  }
  const connections = {};
  for (const [from, to, output = 0] of links) {
    connections[from] ??= { main: [] };
    while (connections[from].main.length <= output) connections[from].main.push([]);
    connections[from].main[output].push({ node: to, type: 'main', index: 0 });
  }
  let column = 0;
  const placed = nodes.map((node) => ({ id: uid(), position: node.position ?? [column++ * 220, 0], ...node }));
  return {
    id: `exprlab-${id}`,
    name: `expr lab ${id}: ${title}`,
    nodes: placed,
    connections,
    ...(pinData ? { pinData } : {}),
    settings: { executionOrder: 'v1', ...settings },
    active: false,
  };
}

// Webhook -> Items -> start -> Edit Fields
const straight = (id, title, start, expression, more = {}) =>
  workflow(
    id,
    title,
    [webhook(id), items(), start, editJson(expression)],
    [
      ['Webhook', 'Items'],
      ['Items', 'start'],
      ['start', 'Edit Fields', more.output ?? 0],
    ],
    { probeFrom: ['start', more.output ?? 0], ...more },
  );

const quoted = (expression) => `JSON.stringify(${expression} ?? null)`;

const cases = [];
const FIND_FAILED = "$('start').all().find((item) => item.json.error !== undefined)";

// 01 The run did not produce the error the editor still shows.
cases.push(straight('01-no-error-this-run-broken', 'start did not fail in this run', softStart(), AUTHOR));
cases.push(
  workflow(
    '01-no-error-this-run-fixed',
    'only build the failure event when start failed',
    [
      webhook('01-no-error-this-run-fixed'),
      items(),
      softStart(),
      ifNode('start failed?', `${FIND_FAILED} !== undefined`),
      editJson(quoted(`${FIND_FAILED}.json.error`)),
      { ...noOp('No failure'), position: [880, 200] },
    ],
    [
      ['Webhook', 'Items'],
      ['Items', 'start'],
      ['start', 'start failed?'],
      ['start failed?', 'Edit Fields', 0],
      ['start failed?', 'No failure', 1],
    ],
  ),
);

// 02 start has pinned output. Manual runs use it, production runs do not.
// The Manual trigger is there so a test can start a manual run without a
// browser; it sends an item that does not fail, like the webhook call does.
const pinned = { start: [{ json: { error: MESSAGE } }] };
const manualTrigger = (position) => ({ name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {}, position });
cases.push(
  workflow(
    '02-pinned-node',
    'start has pinned data from a failed run',
    [
      webhook('02-pinned-node'),
      manualTrigger([0, 200]),
      { ...items(), parameters: { jsCode: 'return [{ json: { id: 1 } }];' }, position: [220, 0] },
      { ...softStart(), position: [440, 0] },
      { ...editJson(AUTHOR), position: [660, 0] },
    ],
    [
      ['Webhook', 'Items'],
      ['Manual', 'Items'],
      ['Items', 'start'],
      ['start', 'Edit Fields'],
    ],
    { pinData: pinned },
  ),
);

// 03 start is the trigger, pinned with a shape the live trigger never sends.
const triggerCase = (id, title, expression, pinData) => workflow(id, title, [webhook(id, 'start'), editJson(expression)], [['start', 'Edit Fields']], { pinData, probeFrom: ['start'] });
cases.push(triggerCase('03-pinned-trigger-shape-broken', 'start is a trigger pinned with { error }', AUTHOR, pinned));
cases.push(triggerCase('03-pinned-trigger-shape-fixed', 'read the field where the live webhook puts it', quoted("$('start').first().json.body.error")));

// 04 start fails with On Error = Continue (using error output).
cases.push(straight('04-error-output', 'Edit Fields on the error output of start', codeStart('continueErrorOutput'), quoted(AUTHOR), { output: 1 }));
const bothOutputs = (id, title, expression) =>
  workflow(
    id,
    title,
    [webhook(id), items(), codeStart('continueErrorOutput'), { ...noOp('Success step'), position: [660, -200] }, { ...editJson(expression), position: [880, 0] }],
    [
      ['Webhook', 'Items'],
      ['Items', 'start'],
      ['start', 'Success step', 0],
      ['Success step', 'Edit Fields'],
      ['start', 'Edit Fields', 1],
    ],
    { probeFrom: ['start', 1] },
  );
cases.push(bothOutputs('04-error-output-both-wired', 'both outputs of start lead to Edit Fields', quoted(AUTHOR)));

// 05 Several items, the failed one is not the first.
cases.push(straight('05-failed-item-not-first-broken', 'all()[0] is the first item, not the failed one', softStart(), AUTHOR));
cases.push(straight('05-failed-item-not-first-fixed', 'the item that belongs to this one', softStart(), quoted("$('start').item.json.error")));

// 06 start runs inside a loop: all() is the last run only.
const filterFailed = {
  name: 'Failed only',
  type: 'n8n-nodes-base.filter',
  typeVersion: 2.2,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: uid(), leftValue: '={{ $json.error }}', rightValue: '', operator: { type: 'string', operation: 'exists', singleValue: true } }],
      combinator: 'and',
    },
    looseTypeValidation: true,
    options: {},
  },
};
const loopCase = (id, title, expression, pick) =>
  workflow(
    id,
    title,
    [webhook(id), items(), loop(), { ...softStart(), position: [660, 200] }, ...(pick ? [{ ...pick, position: [660, 0] }] : []), { ...editJson(expression), position: [880, 0] }],
    [
      ['Webhook', 'Items'],
      ['Items', 'Loop Over Items'],
      ['Loop Over Items', 'start', 1],
      ['start', 'Loop Over Items'],
      ...(pick
        ? [
            ['Loop Over Items', pick.name, 0],
            [pick.name, 'Edit Fields'],
          ]
        : [['Loop Over Items', 'Edit Fields', 0]]),
    ],
    { probeFrom: ['Loop Over Items', 0] },
  );
cases.push(loopCase('06-loop-last-run-broken', 'all() only sees the last run of start', AUTHOR));
cases.push(loopCase('06-loop-last-run-fixed', 'filter the failed items on the done output', quoted('$json.error'), filterFailed));

// 06b Edit Fields runs inside the loop too: one run per item, each with its
// own run of start.
cases.push(
  workflow(
    '06-inside-loop',
    'Edit Fields inside the loop, after start',
    [webhook('06-inside-loop'), items(), loop(), { ...softStart(), position: [660, 200] }, { ...editJson(AUTHOR), position: [880, 200] }],
    [
      ['Webhook', 'Items'],
      ['Items', 'Loop Over Items'],
      ['Loop Over Items', 'start', 1],
      ['start', 'Edit Fields'],
      ['Edit Fields', 'Loop Over Items'],
    ],
  ),
);

// 07 start is on another branch than Edit Fields, or not on the path at all.
const branchCase = (id, title, order, editY, startY) =>
  workflow(
    id,
    title,
    [webhook(id), items(), { ...softStart(), position: [440, startY] }, { ...noOp('After start'), position: [660, startY] }, { ...editJson(AUTHOR), position: [440, editY] }],
    [
      ['Webhook', 'Items'],
      ['Items', 'Edit Fields'],
      ['Items', 'start'],
      ['start', 'After start'],
    ],
    { settings: { executionOrder: order } },
  );
cases.push(branchCase('07-other-branch-v1', 'Edit Fields branch is above the start branch', 'v1', 0, 200));
cases.push(branchCase('07-other-branch-v1-swapped', 'start branch is above the Edit Fields branch', 'v1', 200, 0));
cases.push(branchCase('07-other-branch-v0', 'legacy execution order, Edit Fields branch above', 'v0', 0, 200));
cases.push(
  workflow(
    '07-not-on-path',
    'start is behind an IF this run did not take',
    [webhook('07-not-on-path'), items(), ifNode('Use start?', '$json.use_start === true'), softStart(), { ...editJson(AUTHOR), position: [880, 200] }],
    [
      ['Webhook', 'Items'],
      ['Items', 'Use start?'],
      ['Use start?', 'start', 0],
      ['start', 'Edit Fields'],
      ['Use start?', 'Edit Fields', 1],
    ],
  ),
);

// 08 Where the error lives, per way of failing. Edit Fields returns the
// whole item of start as "msg", so the answer shows the shape.
const WHOLE = quoted("$('start').all()[0].json");
cases.push(straight('08-shape-code-regular', 'Code node throws, Continue', codeStart('continueRegularOutput'), WHOLE));
cases.push(straight('08-shape-code-error-output', 'Code node throws, Continue (using error output)', codeStart('continueErrorOutput'), WHOLE, { output: 1 }));
cases.push(straight('08-shape-http-regular', 'HTTP Request, Continue', httpStart('continueRegularOutput'), WHOLE));
cases.push(straight('08-shape-http-error-output', 'HTTP Request, Continue (using error output)', httpStart('continueErrorOutput'), WHOLE, { output: 1 }));
cases.push(
  straight('08-shape-http-never-error', 'HTTP Request, Never Error + full response', httpStart(undefined, 'processor', { response: { response: { fullResponse: true, neverError: true } } }), WHOLE),
);
cases.push(straight('08-shape-http-error-in-body', 'HTTP 200 with an error object in the body', httpStart(undefined, 'soft'), WHOLE));

// 09 The type of the field in manual mapping. start returns a string, or an
// object when the item has "as_object".
const typeCase = (id, title, type, options = {}) =>
  workflow(
    id,
    title,
    [
      webhook(id),
      items(),
      {
        ...softStart(),
        parameters: {
          mode: 'runOnceForEachItem',
          jsCode: [
            'if ($json.fail && $json.as_object) return { json: { error: { message: $json.fail } } };',
            'if ($json.fail) return { json: { error: $json.fail } };',
            "return { json: { id: $json.id, status: 'processed' } };",
          ].join('\n'),
        },
      },
      editManual(AUTHOR, { name: 'Edit Fields', type, field: 'msg', options }),
    ],
    [
      ['Webhook', 'Items'],
      ['Items', 'start'],
      ['start', 'Edit Fields'],
    ],
  );
cases.push(typeCase('09-type-string', 'String field', 'string'));
cases.push(typeCase('09-type-object', 'Object field', 'object'));
cases.push(typeCase('09-type-object-ignore', 'Object field, Ignore Type Conversion Errors', 'object', { ignoreConversionErrors: true }));

// 10 Include Other Input Fields.
cases.push(
  workflow(
    '10-include-other-fields',
    'JSON mode with Include Other Input Fields',
    [webhook('10-include-other-fields'), items(), softStart(), editJson(AUTHOR, { include: true })],
    [
      ['Webhook', 'Items'],
      ['Items', 'start'],
      ['start', 'Edit Fields'],
    ],
  ),
);

// 11 JSON mode pastes the value in without quotes.
cases.push(straight('11-unquoted-in-json-broken', 'the value is pasted into the JSON as it is', softStart(), AUTHOR));
cases.push(straight('11-unquoted-in-json-fixed', 'JSON.stringify the value', softStart(), quoted(AUTHOR)));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const item of cases) writeFileSync(join(out, `${item.id.replace('exprlab-', '')}.json`), `${JSON.stringify(item, null, 2)}\n`);
console.log(`wrote ${readdirSync(out).length} workflows${PROBE ? ' (with probe nodes)' : ''}`);
