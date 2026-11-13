// Stand-in for the service the node called "start" talks to.
//
//   POST /processor   body { id, fail }
//                     fail empty  -> 200 { id, status: "processed" }
//                     fail set    -> 500 { message: <fail> }
//   POST /soft        the same, but a failure is a 200 with
//                     { error: { code, message } } in the body
//   GET  /health

import { createServer } from 'node:http';

const read = (request) =>
  new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => {
      try {
        resolve(JSON.parse(text || '{}'));
      } catch {
        resolve({});
      }
    });
  });

const send = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

createServer(async (request, response) => {
  const url = new URL(request.url, 'http://standin');
  if (url.pathname === '/health') return send(response, 200, { ok: true });
  const body = await read(request);
  const id = body.id ?? null;
  if (url.pathname === '/processor') {
    if (body.fail) return send(response, 500, { message: String(body.fail) });
    return send(response, 200, { id, status: 'processed' });
  }
  if (url.pathname === '/soft') {
    if (body.fail) return send(response, 200, { id, error: { code: 'PROCESSOR_REQUEST_FAILED', message: String(body.fail) } });
    return send(response, 200, { id, status: 'processed' });
  }
  send(response, 404, { message: 'not found' });
}).listen(8080, () => console.log('standin: listening on 8080'));
