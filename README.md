# n8n expression: value in the preview, null in the run

[![test](https://github.com/feversoul/n8n-expression-preview-vs-run/actions/workflows/test.yml/badge.svg)](https://github.com/feversoul/n8n-expression-preview-vs-run/actions/workflows/test.yml)

An Edit Fields node holds `{{ $('start').all()[0].json.error }}`. The editor preview shows an error message. The run returns `"msg": null`. This repository rebuilds that node on a real n8n and tries the suspected causes one by one, each as a small workflow in a broken and a fixed form, with a test that asserts what the node actually returned.

Run on n8n 2.46.7, the version from the [forum thread](https://community.n8n.io/t/328600), and again on 2.47.7 (Docker, SQLite, regular mode). Built-in nodes only.

| Asked in the thread                                              | What you get                                                                                                                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Why is `msg` null in the run when the preview shows the message? | Five setups that give exactly that, and six suspects that do not. In all five the item the expression read at run time had no `error` field.                      |
| "If it has pinned data, the preview is showing that"             | Measured: a manual run uses the pinned item and returns the message, a production run ignores the pin and returns null. Cases 02 and 03.                          |
| What to change                                                   | The fix per cause as an importable workflow, plus one change that applies to the expression as posted: it puts the message into the JSON without quotes. Case 11. |

## The short answer

`null` is what Edit Fields writes when the expression comes out as `undefined`. It does not fail and does not warn. That holds in JSON mode and in manual mapping, for every field type.

In every case tried, the preview and the run agreed when they looked at the same data. The preview is calculated in the browser from the data the editor holds at that moment: the last run made in the editor, or pinned data. A run calculates it from its own data. So "message in the preview, null in the run" means the first item `start` returned in that run had no `error`, and the fastest check is to open that execution, click `start`, and read its output.

## What gives null

Edit Fields is in JSON mode, as in the thread's screenshot:

```
{
  "e_event": "PROCESSOR_REQUEST_FAILED",
  "msg": {{ $('start').all()[0].json.error }}
}
```

| #   | Setup                                                                                    | The run returns                                              | Fixed form                                                                                            |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 01  | `start` failed in the run you built the node with, and did not fail in this one          | `null`                                                       | An IF before Edit Fields, so the failure event is only built when `start` returned an error           |
| 02  | `start` has pinned data from a failed run                                                | manual run: the message. production run: `null`              | Unpin `start`. Pins only apply to runs started in the editor                                          |
| 03  | `start` is the trigger, pinned with `{ "error": ... }`; the live webhook sends a body    | manual run: the message. production run: `null`              | Read it where the live trigger puts it: `$('start').first().json.body.error`                          |
| 05  | `start` returns three items and the second one failed                                    | `null` on all three, `all()[0]` is always the first item     | `$('start').item.json.error`: `null`, the message, `null`                                             |
| 06  | `start` runs inside Loop Over Items, Edit Fields sits after the loop, item 1 of 3 failed | `null` on all three, `all()` is the last run of `start` only | Read the items on the loop's "done" output (`$json.error`) behind a Filter: one item with the message |

Related to 06: with Edit Fields inside the loop, it runs once per item. Only the run that belongs to the failed item has the message, the other runs return `null`. The preview and the output panel each show one run, the last one by default.

## What does not give null

| #   | Suspect                                                                              | What happened                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 04  | `start` on "Continue (using error output)", Edit Fields on the error output          | The message. `$('start').all()` reads the error output there. With both outputs wired to Edit Fields it still reads the error output, also for the items that succeeded.      |
| 07  | `start` on a branch that runs after Edit Fields (execution order v1 and v0)          | The run fails: `Node 'start' hasn't been executed`. With the `start` branch placed above, it works.                                                                           |
| 07  | `start` behind an IF the run did not take                                            | The same failure.                                                                                                                                                             |
| 08  | `error` is an object, not a string                                                   | Edit Fields returns the object. See the shapes below.                                                                                                                         |
| 09  | Field type in manual mapping                                                         | String field: a string stays, an object becomes its JSON text. Object field with a string: the run fails with `'msg' expects a object`. A missing value is `null` either way. |
| 10  | Include Other Input Fields                                                           | No effect on `msg`.                                                                                                                                                           |
| -   | Expression engine. The server uses `vm` by default, the editor preview uses `legacy` | Every result above was the same with `N8N_EXPRESSION_ENGINE=legacy`.                                                                                                          |

## Where `error` lives

The item `start` returns when it fails, by node and setting:

| `start` is                                                              | Item                                                                                                  |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Code node that throws, Continue                                         | `{ "error": "<message> [line 2]" }`. The Code node adds the line number.                              |
| Code node that throws, Continue (using error output)                    | The input item plus `"error": "<message> [line 2]"`, on the second output. The first output is empty. |
| HTTP Request, answer 500, Continue                                      | `{ "error": { "message": "500 - ...", "name": "AxiosError", "status": 500, "stack": ... } }`          |
| HTTP Request, answer 500, error output                                  | The input item plus that `error` object.                                                              |
| HTTP Request, options Never Error + Include Response Headers and Status | `{ "statusCode": 500, "body": { ... } }`. There is no `error` field.                                  |
| HTTP Request, answer 200 with an error in the body                      | Whatever the service sent, here `{ "id": 1, "error": { "code": ..., "message": ... } }`               |

## One more thing in the expression as posted

In JSON mode the value is pasted into the text as it is, without quotes, and n8n then repairs the JSON if it can. The message from the thread survives that. Others do not:

| `error` is                                                   | `msg` with `{{ ... }}`                                         | with `{{ JSON.stringify(...) }}` |
| ------------------------------------------------------------ | -------------------------------------------------------------- | -------------------------------- |
| `error:1C80006B:Provider routines::wrong final block length` | the same string                                                | the same string                  |
| `He said "no"`                                               | run fails: `The 'JSON Output' in item 0 contains invalid JSON` | the same string                  |
| `bad block [line 2]`                                         | run fails, same message                                        | the same string                  |
| `timeout, then reset`                                        | run fails, same message                                        | the same string                  |
| `true`                                                       | the boolean `true`                                             | the string `"true"`              |
| `42`                                                         | the number `42`                                                | the string `"42"`                |
| missing                                                      | `null`                                                         | `null`                           |

So in JSON mode write it like this:

```
"msg": {{ JSON.stringify($('start').all()[0].json.error ?? null) }}
```

## Check your own workflow

1. Open the execution that returned null (Executions tab), click `start`, and look at the output of that run. Is there an `error` field on the first item? If not, that is the answer, and the rest is finding out why this run differs from the one in the editor.
2. Does `start` show a pin icon in the editor? Then manual runs use the pinned item and production runs do not (02, 03).
3. Does `start` return more than one item, or run more than once? `all()[0]` is the first item of the last run (05, 06).
4. Is `error` at the top of the item, or under `body`, or an object with `message` inside (03, 08)?
5. If `start` only has an `error` when it fails, put an IF before Edit Fields (01).

To try a case, import its file from `workflows/` into any n8n, activate it, and POST to its webhook. The body lists the items `start` should process: `{ "items": [{ "id": 1, "fail": "some message" }, { "id": 2 }] }`. The workflows of row 08 marked HTTP call a stand-in service that only exists in the Docker stack below.

## What was tested

`npm run test:e2e` starts n8n and the stand-in, imports and publishes the 28 workflows, runs each over its production webhook, and for the pinned cases also starts a manual run through the request the editor sends for "Execute workflow". Every assertion is on the items Edit Fields returned in that execution.

| Run                                              | Result          |
| ------------------------------------------------ | --------------- |
| n8n 2.46.7, expression engine `vm` (the default) | 17 of 17 passed |
| n8n 2.46.7, `N8N_EXPRESSION_ENGINE=legacy`       | 17 of 17 passed |
| n8n 2.47.7, expression engine `vm`               | 17 of 17 passed |

The preview itself was looked at by hand, not in the test suite: a headless Chromium opened the editor of n8n 2.46.7, ran the workflow there, opened Edit Fields and read the "Result" box under the expression. Seen for cases 01, 02, 03, 04, 05, 06 and 11:

- After a run in the editor, the preview and the output of that run agreed every time. Where the run gave `null`, the preview showed `[undefined]`.
- With `start` pinned and nothing run yet (02, 03), the preview showed `[Execute previous nodes for preview]` for this expression. After one run in the editor it showed the pinned message.

## What was not tested, and other limits

- The workflow from the thread. It was not posted, only two screenshots, so the type of the `start` node and its settings are not known. `start` here is a Code node or an HTTP Request node.
- PostgreSQL as n8n's database (the thread uses it; this ran on SQLite), queue mode, n8n Cloud.
- "Execute step" on a single node, and the run selector of the input and output panels set to different runs.
- Sub-workflows, where `start` would be "When Executed by Another Workflow", and error workflows.
- Other ways to write the expression (`$json`, `$node[...]`, `$items()`), other nodes than Edit Fields 3.4.
- The preview checks were done once by hand on 2.46.7 and are not repeated by `npm run test:e2e`.
- The decrypt error in the screenshot is only used as text. Nothing here decrypts anything.

## Run it yourself

```sh
git clone https://github.com/feversoul/n8n-expression-preview-vs-run
cd n8n-expression-preview-vs-run
npm run test:e2e
```

Needs Docker and Node 20 or newer. A run takes about a minute; most of it is n8n publishing the workflows one by one. `N8N_IMAGE=n8nio/n8n:2.47.7` picks another version, `N8N_EXPRESSION_ENGINE=legacy` the older expression engine, `KEEP_STACK=1` leaves the stack up with the editor on http://localhost:55692.

To look around by hand: `docker compose up -d`, wait for "workflows imported and published" in the n8n log, then:

```sh
curl -s -X POST localhost:5678/webhook/exprlab/06-loop-last-run-broken -H 'Content-Type: application/json' \
  -d '{"items":[{"id":1,"fail":"decrypt failed"},{"id":2},{"id":3}]}'
# [{"e_event":"PROCESSOR_REQUEST_FAILED","msg":null}, ... three times]
```

Each case is at `/webhook/exprlab/<file name without .json>`.

The workflow files are generated: `scripts/build.mjs` describes the cases. After changing it, run `npm run build`. `PROBE=1 npm run build` adds a node to most workflows that prints what `$('start')` returns in several spellings (`all()`, `first()`, `item`, a given output or run); it is how the cases were explored.

## License

MIT.
