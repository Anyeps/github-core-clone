// Git object model: SHA-1 object ids, commit/tree/tag parse + build, packfile read with
// OFS_DELTA / REF_DELTA resolution, and reachability walks (with an optional commit-depth
// limit, for shallow fetches). No deltas are ever written: the server emits plain objects.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, ObjType, Repo } from './store.ts';
import { ZERO_OID } from './store.ts';

export { deflateSync };

export function oidOf(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

// -------------------------------------------------------------------------------- commit

export interface CommitParts {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(parts: CommitParts): Buffer {
  const lines: string[] = [`tree ${parts.tree}`];
  for (const p of parts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${parts.author}`);
  lines.push(`committer ${parts.committer}`);
  lines.push('');
  return Buffer.from(`${lines.join('\n')}\n${parts.message}`, 'utf8');
}

// -------------------------------------------------------------------------------- tree

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space + 1);
    if (space === -1 || nul === -1 || nul + 21 > data.length) break;
    const mode = data.subarray(pos, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------- tag

export interface TagParts {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = ZERO_OID;
  let type: ObjType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(parts: TagParts): Buffer {
  const lines = [`object ${parts.object}`, `type ${parts.type}`, `tag ${parts.tag}`, `tagger ${parts.tagger}`, ''];
  return Buffer.from(`${lines.join('\n')}\n${parts.message}`, 'utf8');
}

// -------------------------------------------------------------------------------- pack read

const TYPE_CODES: Record<number, ObjType | 'ofs-delta' | 'ref-delta'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};

function readPackVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = buf[pos] & 0x7f;
  let p = pos + 1;
  while (buf[p - 1] & 0x80) {
    value = (value << 7) | (buf[p] & 0x7f);
    p += 1;
  }
  return { value, next: p };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[p++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const tgtSize = readVarint();
  const out: Buffer[] = [];
  let total = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      if (op & 0x01) off = delta[p++];
      if (op & 0x02) off |= delta[p++] << 8;
      if (op & 0x04) off |= delta[p++] << 16;
      if (op & 0x08) off |= delta[p++] << 24;
      if (op & 0x10) size = delta[p++];
      if (op & 0x20) size |= delta[p++] << 8;
      if (op & 0x40) size |= delta[p++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(off, off + size));
      total += size;
    } else if (op !== 0) {
      out.push(delta.subarray(p, p + op));
      p += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== tgtSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Parse a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA. Bases may come from the
 * pack itself, from `lookup` (the repo's store, for REF_DELTA against objects the server
 * already holds), or from `haveObjects`. Throws on malformed input.
 */
export function readPack(
  pack: Buffer,
  lookup?: (oid: string) => GitObject | undefined,
): PackReadResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  // Objects parsed so far, in pack order, with the pack offset where each object's header
  // starts (OFS_DELTA bases are addressed relative to that).
  const byOffset = new Map<number, { oid: string; type: ObjType; data: Buffer }>();
  let pos = 12;
  let deltaCount = 0;
  for (let i = 0; i < count; i += 1) {
    const headerStart = pos;
    let byte = pack[pos++];
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const typeName = TYPE_CODES[typeCode];
    if (typeName === undefined) throw new Error(`unknown pack object type ${typeCode}`);
    if (typeName === 'ofs-delta') {
      // git's offset encoding
      let b = pack[pos++];
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = pack[pos++];
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      const base = byOffset.get(headerStart - offset);
      if (base === undefined) throw new Error('ofs-delta base not in pack');
      const { data: inflated, next } = inflateAt(pack, pos);
      pos = next;
      const data = applyDelta(base.data, inflated);
      if (data.length !== size) throw new Error('ofs-delta size mismatch');
      const oid = oidOf(base.type, data);
      const obj: GitObject = { type: base.type, data };
      objects.set(oid, obj);
      byOffset.set(headerStart, { oid, type: base.type, data });
      deltaCount += 1;
      continue;
    }
    if (typeName === 'ref-delta') {
      const baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      let base = byOffset.size > 0 ? [...byOffset.values()].find((o) => o.oid === baseOid) : undefined;
      if (base === undefined && lookup !== undefined) {
        const found = lookup(baseOid);
        if (found !== undefined) base = { oid: baseOid, type: found.type, data: found.data };
      }
      if (base === undefined) throw new Error('ref-delta base not found');
      const { data: inflated, next } = inflateAt(pack, pos);
      pos = next;
      const data = applyDelta(base.data, inflated);
      if (data.length !== size) throw new Error('ref-delta size mismatch');
      const oid = oidOf(base.type, data);
      const obj: GitObject = { type: base.type, data };
      objects.set(oid, obj);
      byOffset.set(headerStart, { oid, type: base.type, data });
      deltaCount += 1;
      continue;
    }
    const { data: inflated, next } = inflateAt(pack, pos);
    pos = next;
    if (inflated.length !== size) throw new Error('pack object size mismatch');
    const oid = oidOf(typeName, inflated);
    const obj: GitObject = { type: typeName, data: inflated };
    objects.set(oid, obj);
    byOffset.set(headerStart, { oid, type: typeName, data: inflated });
  }
  return { objects, deltaCount };
}

/**
 * Inflate the zlib stream starting at `pos` and return its data plus the offset just past
 * it. With `{ info: true }` Node's inflateSync reports how many input bytes the stream
 * consumed (`engine.bytesWritten`), so one call finds the end exactly — no binary search
 * and no throwing probes (a throwing inflateSync costs ~7x a clean one: the Error's stack
 * capture dominates). Detected once at load; runtimes without the `info` option fall back
 * to the binary search for the shortest prefix that inflates cleanly (a shorter prefix
 * always throws "unexpected end of file"; any longer prefix also succeeds, since
 * inflateSync ignores trailing bytes).
 */
const INFLATE_INFO_OK: boolean = (() => {
  try {
    const probe = inflateSync(deflateSync(Buffer.from('x')), { info: true }) as unknown as {
      buffer?: Buffer;
      engine?: { bytesWritten?: number };
    };
    return typeof probe?.engine?.bytesWritten === 'number';
  } catch {
    return false;
  }
})();

function inflateAt(pack: Buffer, pos: number): { data: Buffer; next: number } {
  if (INFLATE_INFO_OK) {
    const { buffer, engine } = inflateSync(pack.subarray(pos), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    return { data: buffer, next: pos + engine.bytesWritten };
  }
  let lo = 1;
  let hi = pack.length - pos;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(pack.subarray(pos, pos + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(pack.subarray(pos, pos + lo)), next: pos + lo };
}

// -------------------------------------------------------------------------------- reachability

export interface ReachResult {
  /** Every reachable object id (commits, trees, blobs, tags). */
  set: Set<string>;
  /** Depth of each reachable commit (tip = 1). */
  commitDepth: Map<string, number>;
}

/**
 * Walk from `tips` through commits (parents), tags (target) and trees (entries).
 * `maxDepth` limits commit generations from the tips (1 = the tips only).
 * `boundaries` are commits the walker already holds shallowly: their trees are
 * included, but their parents are not walked (the client does not have them).
 */
export function reachable(repo: Repo, tips: Iterable<string>, maxDepth = Infinity, boundaries: ReadonlySet<string> = new Set()): ReachResult {
  const set = new Set<string>();
  const commitDepth = new Map<string, number>();
  const stack: Array<{ oid: string; depth: number }> = [];
  for (const tip of tips) {
    if (tip !== ZERO_OID && repo.objects.has(tip)) stack.push({ oid: tip, depth: 1 });
  }
  const visitTree = (oid: string): void => {
    if (set.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    set.add(oid);
    for (const e of parseTree(obj.data)) {
      if (set.has(e.oid)) continue;
      const child = repo.objects.get(e.oid);
      if (child === undefined) continue;
      if (child.type === 'tree') visitTree(e.oid);
      else set.add(e.oid);
    }
  };
  while (stack.length > 0) {
    const { oid, depth } = stack.pop() as { oid: string; depth: number };
    if (set.has(oid)) {
      // A commit seen at a shallower depth already: keep the smallest depth.
      const prev = commitDepth.get(oid);
      if (prev !== undefined && prev <= depth) continue;
    }
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    set.add(oid);
    if (obj.type === 'commit') {
      commitDepth.set(oid, depth);
      const parts = parseCommit(obj.data);
      visitTree(parts.tree);
      if (depth < maxDepth && !boundaries.has(oid)) {
        for (const p of parts.parents) {
          if (repo.objects.has(p)) stack.push({ oid: p, depth: depth + 1 });
        }
      }
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (repo.objects.has(tag.object)) stack.push({ oid: tag.object, depth });
    } else if (obj.type === 'tree') {
      visitTree(oid);
    }
  }
  return { set, commitDepth };
}

/** True when `ancestor` is reachable from `tip` by following parents (or equal). */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>([tip]);
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      if (!seen.has(p)) {
        seen.add(p);
        stack.push(p);
      }
    }
  }
  return false;
}

/** The root tree oid of a commit (null when the commit does not exist). */
export function treeOfCommit(repo: Repo, commitOid: string | null): string | null {
  if (commitOid === null) return null;
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

/** Flatten a tree (by oid) to path -> {oid, mode}. */
export function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
  return out;
}

/** Store a tree object in the repo and return its oid. */
export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = oidOf(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/**
 * Return the root tree oid after setting `path` (segments) to `blobOid` on top of
 * `baseTreeOid` (null = empty tree). Intermediate trees are created/updated in the store.
 */
export function setPathInTree(repo: Repo, baseTreeOid: string | null, segments: string[], blobOid: string): string {
  if (segments.length === 0) return baseTreeOid ?? putObject(repo, 'tree', Buffer.alloc(0));
  const [head, ...rest] = segments as [string, ...string[]];
  const base = baseTreeOid === null ? [] : parseTree(repo.objects.get(baseTreeOid)?.data ?? Buffer.alloc(0));
  const entries = [...base];
  const idx = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    const entry: TreeEntry = { mode: '100644', name: head, oid: blobOid };
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
  } else {
    const childOid = idx >= 0 && entries[idx]?.mode === '40000' ? entries[idx]?.oid ?? null : null;
    const newChild = setPathInTree(repo, childOid, rest, blobOid);
    const entry: TreeEntry = { mode: '40000', name: head, oid: newChild };
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
  }
  return putObject(repo, 'tree', buildTree(entries));
}

/** Return the root tree oid after removing `path` from `baseTreeOid` (null = empty). */
export function removePathFromTree(repo: Repo, baseTreeOid: string | null, segments: string[]): string {
  if (baseTreeOid === null || segments.length === 0) return baseTreeOid ?? putObject(repo, 'tree', Buffer.alloc(0));
  const [head, ...rest] = segments as [string, ...string[]];
  const entries = parseTree(repo.objects.get(baseTreeOid)?.data ?? Buffer.alloc(0));
  const idx = entries.findIndex((e) => e.name === head);
  if (idx === -1) return baseTreeOid;
  const next = [...entries];
  if (rest.length === 0) {
    next.splice(idx, 1);
  } else {
    const child = entries[idx] as TreeEntry;
    if (child.mode !== '40000') return baseTreeOid;
    const newChild = removePathFromTree(repo, child.oid, rest);
    if (newChild === child.oid) return baseTreeOid;
    const childEntries = parseTree(repo.objects.get(newChild)?.data ?? Buffer.alloc(0));
    if (childEntries.length === 0) next.splice(idx, 1);
    else next[idx] = { mode: '40000', name: head, oid: newChild };
  }
  return putObject(repo, 'tree', buildTree(next));
}
