// Packfile write (plain objects, no deltas), pkt-line framing and sideband-64k.
// The client verifies the pack trailer SHA-1, so every pack is checksummed.

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { GitObject, ObjType } from './store.ts';
import { oidOf } from './git-objects.ts';

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (commits first, then trees/blobs/tags). */
export function writePack(objects: GitObject[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of objects) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** The 32-byte empty pack (header + trailer, 0 objects). */
export function emptyPack(): Buffer {
  return writePack([]);
}

/** Verify a pack's trailer SHA-1. */
export function packChecksumOk(pack: Buffer): boolean {
  if (pack.length < 32) return false;
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return actual === expected;
}

// -------------------------------------------------------------------------------- pkt-line

/** One pkt-line carrying `data` (data usually ends with \n). */
export function pkt(data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = body.length + 4;
  const head = Buffer.allocUnsafe(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Split a buffer into pkt-lines. Returns null on malformed framing. */
export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

export function decodePktLines(buf: Buffer): Pkt[] | null {
  const out: Pkt[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) return null;
    const head = buf.subarray(pos, pos + 4).toString('ascii');
    if (head === '0000') {
      out.push({ kind: 'flush' });
      pos += 4;
      continue;
    }
    if (head === '0001') {
      out.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || pos + len > buf.length) return null;
    out.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return out;
}

// -------------------------------------------------------------------------------- sideband

/** Wrap `data` in sideband band-1 packets (max 65520 payload bytes each). */
export function sidebandPack(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65500;
  for (let off = 0; off < data.length; off += CHUNK) {
    const piece = data.subarray(off, Math.min(data.length, off + CHUNK));
    out.push(pkt(Buffer.concat([Buffer.from([1]), piece])));
  }
  if (data.length === 0) out.push(pkt(Buffer.from([1])));
  return out;
}

/** One sideband band-1 packet carrying a single pkt-line's bytes (report-status lines). */
export function sidebandLine(line: string): Buffer {
  return pkt(Buffer.concat([Buffer.from([1]), Buffer.from(line, 'utf8')]));
}

/** Order objects for a pack: commits, then tags, then trees, then blobs. */
export function orderForPack(objects: Map<string, GitObject>): GitObject[] {
  const list = [...objects.values()];
  const rank = (t: ObjType): number => (t === 'commit' ? 0 : t === 'tag' ? 1 : t === 'tree' ? 2 : 3);
  list.sort((a, b) => rank(a.type) - rank(b.type));
  return list;
}

export { oidOf };
