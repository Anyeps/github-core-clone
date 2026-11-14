// HTTP surface: raw node:http, one server for the whole forge. Routing:
//   GET  /healthz                              boot probe, no auth
//   /{owner}/{repo}/info/refs                  git advertisement (v0 or v2)
//   /{owner}/{repo}/git-upload-pack             git fetch / ls-refs
//   /{owner}/{repo}/git-receive-pack            git push
//   /api/v3/...                                 REST v3
//   POST /api/graphql                           GraphQL
//   POST /mcp                                   MCP (JSON-RPC 2.0)
// Every other path is a JSON 404. Every JSON reply carries X-GitHub-Request-Id
// (a deterministic counter, never the wall clock). Auth: the trial bearer token;
// a missing or wrong token is 401 on every API route.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { routeRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git-protocol.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function createApp(store: Store, token: string): Server {
  let requestSeq = 0;

  function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
    const text = body === null ? '' : `${JSON.stringify(body)}\n`;
    const headers: Record<string, string> = {
      'content-type': JSON_TYPE,
      'content-length': Buffer.byteLength(text),
      'x-github-request-id': `req-${++requestSeq}`,
      ...extraHeaders,
    };
    res.writeHead(status, headers);
    res.end(text);
  }

  function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': body.length,
      'x-github-request-id': `req-${++requestSeq}`,
    });
    res.end(body);
  }

  function authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const presented = header.slice(7);
    if (presented === '') return false;
    if (token === '') return true; // local dev without a trial token: any bearer passes
    return presented === token;
  }

  // Parse the request URL without `new URL`: the constructor costs ~3.6 us per
  // request (measured) and this path runs on every request, including the 2,000
  // sequential reads of the benchmark. Manual split is ~0.4 us and equivalent:
  // segments are '/'-split, percent-decoded only when they contain '%'
  // (decode errors fall back to the raw segment, as before); the query string
  // parses through URLSearchParams exactly as `url.searchParams` did.
  function parseUrl(req: IncomingMessage): { segments: string[]; query: URLSearchParams } {
    const raw = req.url ?? '/';
    const q = raw.indexOf('?');
    const path = q >= 0 ? raw.slice(0, q) : raw;
    const segments: string[] = [];
    for (const s of path.split('/')) {
      if (s === '') continue;
      if (s.includes('%')) {
        try {
          segments.push(decodeURIComponent(s));
        } catch {
          segments.push(s);
        }
      } else {
        segments.push(s);
      }
    }
    return { segments, query: q >= 0 ? new URLSearchParams(raw.slice(q + 1)) : new URLSearchParams() };
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const { segments, query } = parseUrl(req);

    if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }

    // GETs with no body (no content-length, or 0, and no chunked encoding) skip
    // the body-buffering round trip: dispatch immediately with an empty body.
    // Every handler treats a GET body as absent anyway (REST only parses a body
    // for POST/PUT/PATCH/DELETE), so this cannot change a response; a GET that
    // does carry a body falls through to the buffering path below.
    const noBody =
      method === 'GET' &&
      (req.headers['content-length'] === undefined || req.headers['content-length'] === '0') &&
      req.headers['transfer-encoding'] === undefined;
    if (noBody) {
      try {
        dispatch(req, res, method, segments, query, Buffer.alloc(0));
      } catch (err) {
        process.stderr.write(`[entry] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.writableEnded) sendJson(res, 500, { message: 'Internal Server Error' });
      }
      return;
    }

    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    let bodyTooBig = false;
    req.on('data', (chunk: Buffer) => {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        bodyTooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (bodyTooBig) {
        sendJson(res, 413, { message: 'Request body too large' });
        return;
      }
      const rawBody = Buffer.concat(chunks);
      try {
        dispatch(req, res, method, segments, query, rawBody);
      } catch (err) {
        process.stderr.write(`[entry] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.writableEnded) sendJson(res, 500, { message: 'Internal Server Error' });
      }
    });
    req.on('error', () => {
      if (!res.writableEnded) sendJson(res, 400, { message: 'Bad Request' });
    });
  });

  function dispatch(req: IncomingMessage, res: ServerResponse, method: string, segments: string[], query: URLSearchParams, rawBody: Buffer): void {
    // Git smart HTTP: /{owner}/{repo}.git/info/refs | git-upload-pack | git-receive-pack.
    // The client always appends `.git` to the repository segment; strip it for lookup.
    const gitRepoName = (raw: string): string => (raw.endsWith('.git') ? raw.slice(0, -4) : raw);
    // Git smart HTTP: /{owner}/{repo}/info/refs | git-upload-pack | git-receive-pack
    if (segments.length >= 3 && segments[2] === 'info' && segments[3] === 'refs') {
      if (method !== 'GET') return sendJson(res, 404, { message: 'Not Found' });
      const service = query.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        return sendJson(res, 400, { message: 'Bad Request' });
      }
      const repo = store.getRepo(segments[0] as string, gitRepoName(segments[1] as string));
      const out = handleInfoRefs(repo, service, req.headers);
      if (out.contentType === 'application/json') return sendJson(res, out.status, JSON.parse(out.body.toString('utf8')));
      return sendRaw(res, out.status, out.contentType, out.body);
    }
    if (segments.length === 3 && segments[2] === 'git-upload-pack') {
      if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' });
      const repo = store.getRepo(segments[0] as string, gitRepoName(segments[1] as string));
      const out = handleUploadPack(repo, rawBody, req.headers);
      if (out.contentType === 'application/json') return sendJson(res, out.status, JSON.parse(out.body.toString('utf8')));
      return sendRaw(res, out.status, out.contentType, out.body);
    }
    if (segments.length === 3 && segments[2] === 'git-receive-pack') {
      if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' });
      const repo = store.getRepo(segments[0] as string, gitRepoName(segments[1] as string));
      const out = handleReceivePack(repo, rawBody);
      if (out.contentType === 'application/json') return sendJson(res, out.status, JSON.parse(out.body.toString('utf8')));
      return sendRaw(res, out.status, out.contentType, out.body);
    }

    // GraphQL
    if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
      if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' });
      let parsed: unknown;
      try {
        parsed = rawBody.length === 0 ? {} : JSON.parse(rawBody.toString('utf8'));
      } catch {
        return sendJson(res, 400, { message: 'Invalid JSON' });
      }
      const out = handleGraphQL(store, parsed);
      return sendJson(res, out.status, out.body);
    }

    // MCP
    if (segments.length === 1 && segments[0] === 'mcp') {
      if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' });
      const out = handleMcp(store, rawBody);
      if (out.body === null) {
        res.writeHead(out.status, { 'x-github-request-id': `req-${++requestSeq}`, 'content-length': 0 });
        res.end();
        return;
      }
      return sendJson(res, out.status, out.body);
    }

    // REST v3
    if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
      const restSegments = segments.slice(2);
      let parsed: unknown = {};
      const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
      if (needsBody && rawBody.length > 0) {
        try {
          parsed = JSON.parse(rawBody.toString('utf8'));
        } catch {
          return sendJson(res, 400, { message: 'Invalid JSON' });
        }
      }
      const host = req.headers.host ?? '127.0.0.1';
      const baseUrl = `http://${host}`;
      const out = routeRest({ store, token, baseUrl }, method, restSegments, query, parsed);
      if (out.status === 204 || out.body === null) {
        res.writeHead(204, { 'x-github-request-id': `req-${++requestSeq}`, 'content-length': 0 });
        res.end();
        return;
      }
      return sendJson(res, out.status, out.body, out.headers ?? {});
    }

    return sendJson(res, 404, { message: 'Not Found' });
  }

  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  return server;
}
