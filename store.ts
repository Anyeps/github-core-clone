// The forge's in-memory store: repositories, git objects, issues, pull requests.
// Single process, no persistence: a trial starts empty and the suite builds all state
// through the API, so everything lives in Maps. Determinism: every timestamp comes from
// the trial clock (MAKEFUN_TRIAL_NOW + a counter), never from the wall clock.

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
  comments: Comment[];
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  user: string;
  createdAt: string;
  seq: number;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
  /** Bumped on every ref/object change; the git pack cache keys on it. */
  version: number;
}

/** Deterministic clock: base epoch seconds from MAKEFUN_TRIAL_NOW, +1s per stamp. */
export class Clock {
  private counter = 0;
  readonly baseSec: number;
  constructor() {
    const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
    let sec = 1735689600; // 2025-01-01T00:00:00Z fallback
    if (raw !== '') {
      const asNum = Number(raw);
      if (Number.isFinite(asNum) && asNum > 0) {
        sec = asNum > 1e11 ? Math.floor(asNum / 1000) : Math.floor(asNum);
      } else {
        const parsed = Date.parse(raw);
        if (Number.isFinite(parsed)) sec = Math.floor(parsed / 1000);
      }
    }
    this.baseSec = sec;
  }
  /** Next epoch second, strictly increasing per call. */
  nextSec(): number {
    return this.baseSec + this.counter++;
  }
  nextIso(): string {
    return new Date(this.nextSec() * 1000).toISOString();
  }
}

export class Store {
  readonly clock = new Clock();
  readonly repos = new Map<string, Repo>();
  readonly reposById = new Map<number, Repo>();
  private nextRepoId = 1;
  private repoSeq = 0;

  key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  createRepo(name: string, opts: { description?: string; private?: boolean }): Repo | null {
    const key = this.key(VIEWER_LOGIN, name);
    if (this.repos.has(key)) return null;
    const now = this.clock.nextIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER_LOGIN,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      seq: this.repoSeq++,
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      version: 0,
    };
    this.repos.set(key, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    if (owner.toLowerCase() !== VIEWER_LOGIN) return null;
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
    this.reposById.delete(repo.id);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  bump(repo: Repo): void {
    repo.version++;
  }
}

export function b64encode(data: Buffer | string): string {
  return Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data, 'utf8').toString('base64');
}

export function globalId(kind: string, id: string | number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}
