// Git smart HTTP: upload-pack v2 (ls-refs, fetch) + v0, receive-pack v0.
// Response framing follows the suite's client parser exactly:
//  - v2 fetch sections are separated by FLUSH packets, never delim (the client's parser
//    resets its section on delim, so a delim after a section header would break it).
//  - v0 fetch answers plain pkt-lines (shallow/unshallow/NAK) then sideband pack packets.
//  - receive-pack answers report-status inside sideband band 1.

import type { IncomingHttpHeaders } from 'node:http';
import type { GitObject, Repo } from './store.ts';
import { ZERO_OID } from './store.ts';
import { isAncestor, oidOf, parseCommit, parseTag, reachable, readPack } from './git-objects.ts';
import {
  PKT_FLUSH,
  decodePktLines,
  orderForPack,
  packChecksumOk,
  pkt,
  sidebandLine,
  sidebandPack,
  writePack,
} from './git-pack.ts';

export interface GitResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'forge/1.0';
const UPLOAD_CAPS = `side-band-64k thin-pack ofs-delta shallow multi_ack symref=HEAD:refs/heads/main object-format=sha1 agent=${AGENT}`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

function result(status: number, contentType: string, body: Buffer): GitResult {
  return { status, contentType, body };
}

function peelOid(repo: Repo, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
  return cur;
}

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
}

/** All refs, HEAD first, then heads, then tags (each sorted). */
function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const main = repo.refs.get('refs/heads/main');
  if (main !== undefined) out.push({ name: 'HEAD', oid: main });
  const heads = [...repo.refs.entries()]
    .filter(([n]) => n.startsWith('refs/heads/'))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, oid] of heads) out.push({ name, oid });
  const tags = [...repo.refs.entries()]
    .filter(([n]) => n.startsWith('refs/tags/'))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, oid] of tags) {
    const obj = repo.objects.get(oid);
    const peeled = obj !== undefined && obj.type === 'tag' ? peelOid(repo, oid) : undefined;
    out.push({ name, oid, peeled: peeled !== undefined && peeled !== oid ? peeled : undefined });
  }
  return out;
}

// -------------------------------------------------------------------------------- advertisement

export function handleInfoRefs(repo: Repo | null, service: 'git-upload-pack' | 'git-receive-pack', headers: IncomingHttpHeaders): GitResult {
  const v2 = headers['git-protocol'] === 'version=2' && service === 'git-upload-pack';
  const type = `application/x-${service}-advertisement`;
  if (repo === null) return result(404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' })));
  const serviceLine = pkt(`# service=${service}\n`);
  if (v2) {
    const body = Buffer.concat([
      serviceLine,
      PKT_FLUSH,
      pkt('version 2\n'),
      pkt('ls-refs=unborn\n'),
      pkt('fetch=shallow filter\n'),
      pkt('object-format=sha1\n'),
      pkt(`agent=${AGENT}\n`),
      PKT_FLUSH,
    ]);
    return result(200, type, body);
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const refs = listRefs(repo);
  const parts: Buffer[] = [serviceLine, PKT_FLUSH];
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, i) => {
      const first = i === 0 ? `\0${caps}` : '';
      parts.push(pkt(`${ref.oid} ${ref.name}${first}\n`));
      if (ref.peeled !== undefined) parts.push(pkt(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return result(200, type, Buffer.concat(parts));
}

// -------------------------------------------------------------------------------- v2 request parsing

interface V2Request {
  command: string;
  args: string[];
}

function parseV2Request(body: Buffer): V2Request | null {
  const packets = decodePktLines(body);
  if (packets === null) return null;
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) {
      if (line.startsWith('command=')) command = line.slice(8);
    } else {
      args.push(line);
    }
  }
  if (command === '') return null;
  return { command, args };
}

function parseV0FetchRequest(body: Buffer): { wants: string[]; haves: string[]; shallow: string[]; depth: number | null } | null {
  const packets = decodePktLines(body);
  if (packets === null) return null;
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') {
      section += 1;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    const [head, ...rest] = line.split(' ');
    if (section === 0) {
      if (head === 'want' && rest[0] !== undefined) wants.push(rest[0]);
      else if (head === 'shallow' && rest[0] !== undefined) shallow.push(rest[0]);
      else if (head === 'deepen' && rest[0] !== undefined) depth = parseInt(rest[0], 10);
    } else if (head === 'have' && rest[0] !== undefined) {
      haves.push(rest[0]);
    }
  }
  if (wants.length === 0 && section === 0) return null;
  return { wants, haves, shallow, depth };
}

// -------------------------------------------------------------------------------- fetch computation

interface FetchPlan {
  send: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

const packCache = new Map<string, { pack: Buffer; shallow: string[]; unshallow: string[]; wantedRefs: string[]; response?: Buffer }>();

function planFetch(repo: Repo, wants: string[], haves: string[], shallowReq: string[], depth: number | null): FetchPlan {
  const maxDepth = depth ?? Infinity;
  const wantReach = reachable(repo, wants, maxDepth);
  // The client already holds its shallow boundaries' trees, but not their parents:
  // stop the have-walk there, or a deepen would subtract the parent it still needs.
  const haveReach = reachable(repo, haves, Infinity, new Set(shallowReq));
  const send = new Map<string, GitObject>();
  for (const oid of wantReach.set) {
    if (haveReach.set.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj !== undefined) send.set(oid, obj);
  }
  const shallow: string[] = [];
  if (depth !== null) {
    for (const [oid, d] of wantReach.commitDepth) {
      if (d === depth && send.has(oid)) shallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const s of shallowReq) {
    if (!wantReach.set.has(s)) continue;
    const obj = repo.objects.get(s);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.some((p) => send.has(p))) unshallow.push(s);
  }
  return { send, shallow, unshallow };
}

function wantedRefLines(repo: Repo, wants: string[]): string[] {
  const lines: string[] = [];
  const refs = listRefs(repo);
  for (const want of wants) {
    const ref = refs.find((r) => r.oid === want);
    if (ref !== undefined) lines.push(`${want} ${ref.name}`);
  }
  return lines;
}

function buildV2FetchResponse(repo: Repo, wants: string[], haves: string[], shallowReq: string[], depth: number | null): Buffer {
  const key = `${repo.id}:${repo.version}:${wants.join(',')}:${haves.join(',')}:${shallowReq.join(',')}:${depth ?? ''}`;
  const cached = packCache.get(key);
  // The whole response is a pure function of the cache key (repo version included),
  // so a hit returns the exact bytes: no re-framing, no re-chunking the pack.
  if (cached !== undefined && cached.response !== undefined) return cached.response;
  let pack: Buffer | null = null;
  let shallow: string[] = [];
  let unshallow: string[] = [];
  let wantedRefs: string[] = [];
  if (cached !== undefined) {
    pack = cached.pack;
    shallow = cached.shallow;
    unshallow = cached.unshallow;
    wantedRefs = cached.wantedRefs;
  } else {
    const plan = planFetch(repo, wants, haves, shallowReq, depth);
    shallow = plan.shallow;
    unshallow = plan.unshallow;
    wantedRefs = wantedRefLines(repo, wants);
    pack = plan.send.size > 0 ? writePack(orderForPack(plan.send)) : null;
    if (packCache.size > 128) packCache.clear();
    packCache.set(key, { pack: pack ?? Buffer.alloc(0), shallow, unshallow, wantedRefs });
  }
  const parts: Buffer[] = [pkt('acknowledgments\n'), pkt('NAK\n'), PKT_FLUSH];
  parts.push(pkt('shallow-info\n'));
  for (const s of shallow) parts.push(pkt(`shallow ${s}\n`));
  for (const u of unshallow) parts.push(pkt(`unshallow ${u}\n`));
  parts.push(PKT_FLUSH);
  parts.push(pkt('wanted-refs\n'));
  for (const line of wantedRefs) parts.push(pkt(`${line}\n`));
  parts.push(PKT_FLUSH);
  if (pack !== null && pack.length > 0) {
    parts.push(pkt('packfile\n'));
    for (const chunk of sidebandPack(pack)) parts.push(chunk);
    parts.push(PKT_FLUSH);
  }
  const response = Buffer.concat(parts);
  const entry = packCache.get(key);
  if (entry !== undefined) entry.response = response;
  return response;
}

function buildV0FetchResponse(repo: Repo, wants: string[], haves: string[], shallowReq: string[], depth: number | null): Buffer {
  const plan = planFetch(repo, wants, haves, shallowReq, depth);
  const parts: Buffer[] = [];
  for (const s of plan.shallow) parts.push(pkt(`shallow ${s}\n`));
  for (const u of plan.unshallow) parts.push(pkt(`unshallow ${u}\n`));
  parts.push(pkt('NAK\n'));
  if (plan.send.size > 0) {
    const pack = writePack(orderForPack(plan.send));
    for (const chunk of sidebandPack(pack)) parts.push(chunk);
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------- upload-pack

export function handleUploadPack(repo: Repo | null, body: Buffer, headers: IncomingHttpHeaders): GitResult {
  if (repo === null) return result(404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' })));
  const type = 'application/x-git-upload-pack-result';
  if (headers['git-protocol'] === 'version=2') {
    const req = parseV2Request(body);
    if (req === null) return result(400, 'application/json', Buffer.from(JSON.stringify({ message: 'Bad Request' })));
    if (req.command === 'ls-refs') {
      const peel = req.args.includes('peel');
      const symrefs = req.args.includes('symrefs');
      const unborn = req.args.includes('unborn');
      const prefixes = req.args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice(11));
      const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
      const lines: Buffer[] = [];
      const main = repo.refs.get('refs/heads/main');
      if (main === undefined) {
        // Only HEAD is unborn: advertising `unborn refs/heads/main` too makes
        // clients treat the branch as existing (with a zero tip).
        if (unborn && keep('HEAD')) lines.push(pkt('unborn HEAD symref-target:refs/heads/main\n'));
      } else {
        if (keep('HEAD')) {
          lines.push(pkt(symrefs ? `${main} HEAD symref-target:refs/heads/main\n` : `${main} HEAD\n`));
        }
        for (const ref of listRefs(repo)) {
          if (ref.name === 'HEAD') continue;
          if (!keep(ref.name)) continue;
          const extra = peel && ref.peeled !== undefined ? ` peeled:${ref.peeled}` : '';
          lines.push(pkt(`${ref.oid} ${ref.name}${extra}\n`));
        }
      }
      lines.push(PKT_FLUSH);
      return result(200, type, Buffer.concat(lines));
    }
    if (req.command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | null = null;
      for (const arg of req.args) {
        if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) depth = parseInt(arg.slice(7), 10);
      }
      if (wants.length === 0) {
        return result(200, type, Buffer.concat([pkt('acknowledgments\n'), pkt('NAK\n'), PKT_FLUSH, pkt('shallow-info\n'), PKT_FLUSH, pkt('wanted-refs\n'), PKT_FLUSH]));
      }
      return result(200, type, buildV2FetchResponse(repo, wants, haves, shallow, depth));
    }
    return result(400, 'application/json', Buffer.from(JSON.stringify({ message: 'Bad Request' })));
  }
  // v0
  const parsed = parseV0FetchRequest(body);
  if (parsed === null) return result(400, 'application/json', Buffer.from(JSON.stringify({ message: 'Bad Request' })));
  if (parsed.wants.length === 0) {
    return result(200, type, Buffer.concat([pkt('NAK\n'), PKT_FLUSH]));
  }
  return result(200, type, buildV0FetchResponse(repo, parsed.wants, parsed.haves, parsed.shallow, parsed.depth));
}

// -------------------------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: Repo | null, body: Buffer): GitResult {
  const type = 'application/x-git-receive-pack-result';
  if (repo === null) return result(404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' })));
  // The command list is pkt-lines up to the first flush; the pack follows as raw bytes,
  // so parse incrementally (a whole-body pkt-line decode would choke on the pack).
  let pos = 0;
  const commands: PushCommand[] = [];
  let ok = true;
  let sawFlush = false;
  while (pos + 4 <= body.length) {
    const head = body.subarray(pos, pos + 4).toString('ascii');
    if (head === '0000') {
      pos += 4;
      sawFlush = true;
      break;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || pos + len > body.length) {
      ok = false;
      break;
    }
    const line = body.subarray(pos + 4, pos + len).toString('utf8').replace(/\n$/, '');
    pos += len;
    const nul = line.indexOf('\0');
    const bare = nul >= 0 ? line.slice(0, nul) : line;
    const parts = bare.split(' ');
    if (parts.length < 3 || !/^[0-9a-f]{40}$/.test(parts[0] ?? '') || !/^[0-9a-f]{40}$/.test(parts[1] ?? '')) {
      ok = false;
      break;
    }
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
  }
  if (!ok || !sawFlush || commands.length === 0) {
    return result(400, 'application/json', Buffer.from(JSON.stringify({ message: 'Bad Request' })));
  }
  const packBytes = body.subarray(pos);
  // Unpack: parse the pack (if any) and store its objects.
  let unpackError: string | null = null;
  let packed = new Map<string, GitObject>();
  if (packBytes.length > 0) {
    if (!packChecksumOk(packBytes)) {
      unpackError = 'pack checksum mismatch';
    } else {
      try {
        packed = readPack(packBytes, (oid) => repo.objects.get(oid)).objects;
      } catch (err) {
        unpackError = err instanceof Error ? err.message : 'unpack failed';
      }
    }
  }
  const report: string[] = [];
  if (unpackError !== null) {
    report.push(`unpack ${unpackError}\n`);
  } else {
    for (const [oid, obj] of packed) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
    report.push('unpack ok\n');
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // delete
        if (current === undefined) {
          report.push(`ng ${cmd.ref} remote ref does not exist\n`);
        } else {
          repo.refs.delete(cmd.ref);
          report.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      const target = repo.objects.get(cmd.newOid);
      if (target === undefined) {
        report.push(`ng ${cmd.ref} object not found\n`);
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        if (current !== undefined) {
          report.push(`ng ${cmd.ref} non-fast-forward\n`);
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        report.push(`ok ${cmd.ref}\n`);
        continue;
      }
      if (current === undefined) {
        report.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      if (current !== cmd.oldOid) {
        report.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      if (cmd.oldOid === cmd.newOid) {
        report.push(`ok ${cmd.ref}\n`);
        continue;
      }
      if (target.type !== 'commit' || !isAncestor(repo, cmd.oldOid, cmd.newOid)) {
        report.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      report.push(`ok ${cmd.ref}\n`);
    }
    repo.version += 1;
  }
  const parts: Buffer[] = report.map((line) => sidebandLine(line));
  parts.push(PKT_FLUSH);
  return result(200, type, Buffer.concat(parts));
}

