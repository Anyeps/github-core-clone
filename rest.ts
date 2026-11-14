// REST v3: repositories, branches, commits, contents, labels, issues, comments, pulls.
// All responses are JSON with a non-empty X-GitHub-Request-Id (added by app.ts).
// Auth and the owner check happen here: a token that is not the trial token is 401;
// any owner other than the token's login is 404, never 403.

import type { Issue, Label, Pull, Repo, Store } from './store.ts';
import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, b64encode } from './store.ts';
import {
  buildCommit,
  buildTree,
  flattenTree,
  parseCommit,
  parseTree,
  putObject,
  removePathFromTree,
  setPathInTree,
  treeOfCommit,
} from './git-objects.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface RestCtx {
  store: Store;
  token: string;
  baseUrl: string;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const err = (status: number, message: string): RestResult => json(status, { message });
const notFound = (): RestResult => err(404, 'Not Found');

// -------------------------------------------------------------------------------- views

function userJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `/${repo.owner}/${repo.name}`,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return l !== undefined ? labelJson(l) : { name, color: 'ededed', description: '' };
    }),
    user: { login: issue.user, id: VIEWER_ID, type: 'User' },
    assignee: null,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    comments: issue.comments.length,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pull.number,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: { login: pull.user, id: VIEWER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
    closed_at: pull.state === 'closed' ? pull.createdAt : null,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha },
    draft: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const parts = parseCommit(obj.data);
  const authorLine = parts.author || `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  const name = authorLine.split(' <')[0] ?? VIEWER_NAME;
  const email = (authorLine.match(/<([^>]*)>/) ?? [])[1] ?? VIEWER_EMAIL;
  const date = isoFromIdent(authorLine);
  // Git stores the message with its trailing newline; the API presents it without.
  const message = parts.message.endsWith('\n') ? parts.message.slice(0, -1) : parts.message;
  return {
    sha,
    commit: {
      message,
      author: { name, email, date },
      committer: { name, email, date },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: parts.parents.map((p) => ({ sha: p })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

function isoFromIdent(ident: string): string {
  // ident: "Name <email> 1735689600 +0000"
  const m = ident.match(/ (\d+) [+-]\d{4}$/);
  if (m !== null) return new Date(Number(m[1]) * 1000).toISOString();
  return new Date(1735689600 * 1000).toISOString();
}

// -------------------------------------------------------------------------------- git helpers

function resolveRef(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const asBranch = repo.refs.get(`refs/heads/${ref}`);
  if (asBranch !== undefined) return asBranch;
  const obj = repo.objects.get(ref);
  if (obj !== undefined && obj.type === 'commit') return ref;
  return null;
}

function blobAtPath(repo: Repo, treeOid: string | null, path: string): { oid: string; data: Buffer } | null {
  if (treeOid === null) return null;
  const flat = flattenTree(repo, treeOid);
  const entry = flat.get(path);
  if (entry === undefined) return null;
  const obj = repo.objects.get(entry.oid);
  if (obj === undefined || obj.type !== 'blob') return null;
  return { oid: entry.oid, data: obj.data };
}

function dirEntries(repo: Repo, treeOid: string | null, path: string): Array<Record<string, unknown>> | null {
  if (treeOid === null) return null;
  let current = treeOid;
  if (path !== '') {
    // Find the subtree at `path` by walking the tree.
    const segments = path.split('/');
    let oid: string | null = treeOid;
    for (const seg of segments) {
      if (oid === null) return null;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return null;
      const found = parseTree(obj.data).find((e) => e.name === seg);
      if (found === undefined) return null;
      oid = found.oid;
    }
    current = oid;
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
  }
  const obj = repo.objects.get(current);
  if (obj === undefined || obj.type !== 'tree') return null;
  return parseTree(obj.data).map((e) => ({
    type: e.mode === '40000' ? 'dir' : 'file',
    name: e.name,
    path: path === '' ? e.name : `${path}/${e.name}`,
    sha: e.oid,
    size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
  }));
}

/** Create a commit on `branch` setting (or deleting) `path`; returns the new commit oid. */
function commitFile(
  ctx: RestCtx,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; contentSha: string | null } {
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName) ?? null;
  const baseTree = treeOfCommit(repo, tip);
  let newTree: string;
  let contentSha: string | null = null;
  const segments = path.split('/').filter((s) => s !== '');
  if (content === null) {
    newTree = removePathFromTree(repo, baseTree, segments);
  } else {
    contentSha = putObject(repo, 'blob', content);
    newTree = setPathInTree(repo, baseTree, segments, contentSha);
  }
  const sec = ctx.store.clock.nextSec();
  const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${sec} +0000`;
  const commitData = buildCommit({
    tree: newTree,
    parents: tip === null ? [] : [tip],
    author: ident,
    committer: ident,
    message: message.endsWith('\n') ? message : `${message}\n`,
  });
  const commitSha = putObject(repo, 'commit', commitData);
  repo.refs.set(refName, commitSha);
  ctx.store.bump(repo);
  return { commitSha, contentSha };
}

/** Rebuild a nested tree from a flat path map. */
function buildTreeFromMap(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  const build = (prefix: string): string => {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    const dirs = new Set<string>();
    for (const [path, v] of flat) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) entries.push({ mode: v.mode, name: rest, oid: v.oid });
      else dirs.add(rest.slice(0, slash));
    }
    for (const dir of dirs) entries.push({ mode: '40000', name: dir, oid: build(`${prefix}${dir}/`) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build('');
}

interface MergeOutcome {
  conflict: boolean;
  treeOid: string | null;
}

function threeWayMerge(repo: Repo, baseTree: string | null, headTree: string | null, currentTree: string | null): MergeOutcome {
  const base = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const head = headTree === null ? new Map() : flattenTree(repo, headTree);
  const cur = currentTree === null ? new Map() : flattenTree(repo, currentTree);
  const merged = new Map(cur);
  let conflict = false;
  const same = (a: { oid: string; mode: string } | undefined, b: { oid: string; mode: string } | undefined): boolean =>
    (a?.oid ?? null) === (b?.oid ?? null) && (a?.mode ?? null) === (b?.mode ?? null);
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    const c = cur.get(path);
    if (same(h, b)) continue;
    if (same(c, b)) {
      if (h === undefined) merged.delete(path);
      else merged.set(path, h);
      continue;
    }
    if (same(h, c)) continue;
    conflict = true;
  }
  if (conflict) return { conflict: true, treeOid: null };
  return { conflict: false, treeOid: buildTreeFromMap(repo, merged) };
}

/** LCS line diff: additions/deletions between two texts. */
function lineDiff(a: string, b: string): { additions: number; deletions: number } {
  if (a === b) return { additions: 0, deletions: 0 };
  const al = a === '' ? [] : a.split('\n');
  const bl = b === '' ? [] : b.split('\n');
  const n = al.length;
  const m = bl.length;
  // DP LCS on lines; files in the suite are small.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = al[i] === bl[j] ? (dp[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
    }
  }
  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) {
      i += 1;
      j += 1;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      deletions += 1;
      i += 1;
    } else {
      additions += 1;
      j += 1;
    }
  }
  deletions += n - i;
  additions += m - j;
  return { additions, deletions };
}

function pullFiles(repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const baseTree = treeOfCommit(repo, pull.baseSha);
  const headTree = treeOfCommit(repo, pull.headSha);
  const base = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const head = headTree === null ? new Map() : flattenTree(repo, headTree);
  const out: Array<Record<string, unknown>> = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    const bData = b !== undefined ? repo.objects.get(b.oid)?.data.toString('utf8') ?? '' : '';
    const hData = h !== undefined ? repo.objects.get(h.oid)?.data.toString('utf8') ?? '' : '';
    const { additions, deletions } = lineDiff(bData, hData);
    const status = b === undefined ? 'added' : h === undefined ? 'removed' : 'modified';
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

// -------------------------------------------------------------------------------- router

export function routeRest(ctx: RestCtx, method: string, segments: string[], query: URLSearchParams, body: unknown): RestResult {
  const store = ctx.store;
  // GET /api/v3/  (api root)
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, { installed_version: '1.0.0' });
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, userJson());
  }
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
      const all = store.listRepos();
      const start = (page - 1) * perPage;
      const items = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        headers.link = `<${ctx.baseUrl}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}>; rel="next"`;
      }
      return json(200, items.map(repoJson), headers);
    }
    if (method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const name = typeof input.name === 'string' ? input.name : '';
      if (name === '') return err(422, 'name is required');
      const created = store.createRepo(name, {
        description: typeof input.description === 'string' ? input.description : '',
        private: input.private === true,
      });
      if (created === null) return err(422, `name already exists on this account`);
      return json(201, repoJson(created));
    }
    return err(404, 'Not Found');
  }
  if (segments[0] !== 'repos' || segments.length < 3) return err(404, 'Not Found');
  const owner = segments[1] as string;
  const name = segments[2] as string;
  const repo = store.getRepo(owner, name);
  if (repo === null) return notFound();
  const rest = segments.slice(3);

  // GET/PATCH/DELETE /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoJson(repo));
    if (method === 'PATCH') {
      const input = (body ?? {}) as Record<string, unknown>;
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.private = input.private;
      repo.updatedAt = store.clock.nextIso();
      return json(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  // branches
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const list = [...repo.refs.entries()]
        .filter(([n]) => n.startsWith('refs/heads/'))
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([n, oid]) => ({ name: n.slice(11), commit: { sha: oid }, protected: false }));
      return json(200, list);
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) return notFound();
      return json(200, { name: branch, commit: { sha: oid }, protected: false });
    }
    return err(404, 'Not Found');
  }

  // git refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const input = (body ?? {}) as Record<string, unknown>;
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!ref.startsWith('refs/') || sha === '' || repo.objects.get(sha) === undefined) {
        return err(422, 'invalid ref or sha');
      }
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      store.bump(repo);
      return json(201, { ref, object: { sha } });
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = rest.slice(2).join('/');
      const oid = repo.refs.get(ref);
      if (oid === undefined) return notFound();
      return json(200, { ref, object: { sha: oid } });
    }
    return err(404, 'Not Found');
  }

  // commits
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const tip = resolveRef(repo, query.get('sha') ?? undefined);
    if (tip === null) return json(200, []);
    const seen = new Set<string>();
    const stack: string[] = [tip];
    const commits: Array<{ sha: string; sec: number }> = [];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = repo.objects.get(sha);
      if (obj === undefined || obj.type !== 'commit') continue;
      const parts = parseCommit(obj.data);
      const m = parts.committer.match(/ (\d+) [+-]\d{4}$/);
      commits.push({ sha, sec: m !== null ? Number(m[1]) : 0 });
      for (const p of parts.parents) stack.push(p);
    }
    commits.sort((a, b) => b.sec - a.sec);
    return json(200, commits.map((c) => commitJson(repo, c.sha)).filter((c) => c !== null));
  }

  // contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    const ref = query.get('ref') ?? undefined;
    if (method === 'GET') {
      const tip = resolveRef(repo, ref);
      if (tip === null) return notFound();
      const tree = treeOfCommit(repo, tip);
      if (path === '') {
        const entries = dirEntries(repo, tree, '');
        if (entries === null) return notFound();
        return json(200, entries);
      }
      const file = blobAtPath(repo, tree, path);
      if (file !== null) {
        return json(200, {
          type: 'file',
          encoding: 'base64',
          size: file.data.length,
          name: path.split('/').pop() ?? path,
          path,
          content: b64encode(file.data),
          sha: file.oid,
        });
      }
      const entries = dirEntries(repo, tree, path);
      if (entries !== null) return json(200, entries);
      return notFound();
    }
    if (method === 'PUT') {
      const input = (body ?? {}) as Record<string, unknown>;
      const message = typeof input.message === 'string' ? input.message : 'Update';
      const contentB64 = typeof input.content === 'string' ? input.content : '';
      const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
      const sha = typeof input.sha === 'string' ? input.sha : undefined;
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, 'base64');
        if (contentB64 !== '' && content.length === 0 && contentB64.replace(/=+$/, '') !== '') {
          // tolerate: an empty decode of a non-empty string is still accepted as empty
        }
      } catch {
        return err(400, 'content is not valid base64');
      }
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined && repo.refs.size > 0) return notFound();
      const tree = treeOfCommit(repo, tip ?? null);
      const existing = blobAtPath(repo, tree, path);
      if (existing !== null) {
        if (sha === undefined) return err(422, 'sha was not supplied');
        if (sha.toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'sha does not match the current blob');
        const made = commitFile(ctx, repo, branch, path, content, message);
        return json(200, {
          content: { name: path.split('/').pop() ?? path, path, sha: made.contentSha, size: content.length, encoding: 'base64' },
          commit: { sha: made.commitSha, message },
        });
      }
      if (sha !== undefined) return err(422, 'sha supplied for a file that does not exist');
      const made = commitFile(ctx, repo, branch, path, content, message);
      return json(201, {
        content: { name: path.split('/').pop() ?? path, path, sha: made.contentSha, size: content.length, encoding: 'base64' },
        commit: { sha: made.commitSha, message },
      });
    }
    if (method === 'DELETE') {
      const input = (body ?? {}) as Record<string, unknown>;
      const message = typeof input.message === 'string' ? input.message : 'Delete';
      const sha = typeof input.sha === 'string' ? input.sha : undefined;
      const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) return notFound();
      const tree = treeOfCommit(repo, tip);
      const existing = blobAtPath(repo, tree, path);
      if (existing === null) return notFound();
      if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'sha does not match the current blob');
      const made = commitFile(ctx, repo, branch, path, null, message);
      return json(200, { content: null, commit: { sha: made.commitSha, message } });
    }
    return err(404, 'Not Found');
  }

  // labels
  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'GET') {
      return json(200, [...repo.labels.values()].map(labelJson));
    }
    if (rest.length === 1 && method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const labelName = typeof input.name === 'string' ? input.name : '';
      if (labelName === '') return err(422, 'name is required');
      if (repo.labels.has(labelName)) return err(422, 'Label already exists');
      const label: Label = {
        name: labelName,
        color: typeof input.color === 'string' ? input.color : 'ededed',
        description: typeof input.description === 'string' ? input.description : '',
      };
      repo.labels.set(labelName, label);
      return json(201, labelJson(label));
    }
    return err(404, 'Not Found');
  }

  // issues
  if (rest[0] === 'issues') {
    if (rest.length === 1 && method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const title = typeof input.title === 'string' ? input.title : '';
      const bodyText = typeof input.body === 'string' ? input.body : '';
      const labelsRaw = Array.isArray(input.labels) ? input.labels : [];
      const labelNames: string[] = [];
      for (const l of labelsRaw) {
        const labelName = typeof l === 'string' ? l : (l as Record<string, unknown>)?.name;
        if (typeof labelName !== 'string') continue;
        if (!repo.labels.has(labelName)) return err(422, `Label "${labelName}" does not exist`);
        labelNames.push(labelName);
      }
      const now = store.clock.nextIso();
      const issueNumber = repo.nextNumber++;
      const issue: Issue = {
        number: issueNumber,
        title,
        body: bodyText,
        state: 'open',
        labels: labelNames,
        user: VIEWER_LOGIN,
        createdAt: now,
        updatedAt: now,
        seq: issueNumber,
        comments: [],
      };
      repo.issues.set(issue.number, issue);
      return json(201, issueJson(repo, issue));
    }
    if (rest.length === 1 && method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const start = (page - 1) * perPage;
      return json(200, list.slice(start, start + perPage).map((i) => issueJson(repo, i)));
    }
    const num = Number(rest[1]);
    if (rest.length >= 2 && Number.isInteger(num) && num >= 1) {
      const issue = repo.issues.get(num);
      if (rest.length === 2 && method === 'GET') {
        if (issue === undefined) return notFound();
        return json(200, issueJson(repo, issue));
      }
      if (rest.length === 2 && method === 'PATCH') {
        if (issue === undefined) return notFound();
        const input = (body ?? {}) as Record<string, unknown>;
        if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
        if (typeof input.title === 'string') issue.title = input.title;
        if (typeof input.body === 'string') issue.body = input.body;
        issue.updatedAt = store.clock.nextIso();
        return json(200, issueJson(repo, issue));
      }
      if (rest.length === 3 && rest[2] === 'comments' && method === 'POST') {
        if (issue === undefined) return notFound();
        const input = (body ?? {}) as Record<string, unknown>;
        const bodyText = typeof input.body === 'string' ? input.body : '';
        const now = store.clock.nextIso();
        const comment = { id: repo.nextCommentId++, body: bodyText, user: VIEWER_LOGIN, createdAt: now };
        issue.comments.push(comment);
        return json(201, { id: comment.id, body: comment.body, user: { login: comment.user, id: VIEWER_ID, type: 'User' }, created_at: now, updated_at: now });
      }
      if (rest.length === 3 && rest[2] === 'comments' && method === 'GET') {
        if (issue === undefined) return notFound();
        return json(
          200,
          issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: c.user, id: VIEWER_ID, type: 'User' }, created_at: c.createdAt, updated_at: c.createdAt })),
        );
      }
    }
    return err(404, 'Not Found');
  }

  // pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1 && method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const title = typeof input.title === 'string' ? input.title : '';
      const bodyText = typeof input.body === 'string' ? input.body : '';
      const head = typeof input.head === 'string' ? input.head : '';
      const base = typeof input.base === 'string' ? input.base : repo.defaultBranch;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return err(422, 'head or base branch does not exist');
      for (const p of repo.pulls.values()) {
        if (p.state === 'open' && p.headRef === head && p.baseRef === base) {
          return err(422, 'A pull request already exists for these branches');
        }
      }
      const now = store.clock.nextIso();
      const pullNumber = repo.nextNumber++;
      const pull: Pull = {
        number: pullNumber,
        title,
        body: bodyText,
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        user: VIEWER_LOGIN,
        createdAt: now,
        seq: pullNumber,
      };
      repo.pulls.set(pull.number, pull);
      return json(201, pullJson(repo, pull));
    }
    if (rest.length === 1 && method === 'GET') {
      const state = query.get('state') ?? 'open';
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.seq - a.seq);
      const start = (page - 1) * perPage;
      return json(200, list.slice(start, start + perPage).map((p) => pullJson(repo, p)));
    }
    const num = Number(rest[1]);
    if (rest.length >= 2 && Number.isInteger(num) && num >= 1) {
      const pull = repo.pulls.get(num);
      if (rest.length === 2 && method === 'GET') {
        if (pull === undefined) return notFound();
        return json(200, pullJson(repo, pull));
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (pull === undefined) return notFound();
        return json(200, pullFiles(repo, pull));
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) return notFound();
        if (pull.state !== 'open') return err(405, 'Pull request is not open');
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
        if (baseTip === undefined) return notFound();
        const baseTree = treeOfCommit(repo, pull.baseSha);
        const headTree = treeOfCommit(repo, pull.headSha);
        const currentTree = treeOfCommit(repo, baseTip);
        const merged = threeWayMerge(repo, baseTree, headTree, currentTree);
        if (merged.conflict || merged.treeOid === null) return err(405, 'Merge conflict');
        const sec = store.clock.nextSec();
        const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${sec} +0000`;
        const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
        const commitData = buildCommit({ tree: merged.treeOid, parents: [baseTip], author: ident, committer: ident, message });
        const mergeSha = putObject(repo, 'commit', commitData);
        repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = new Date(sec * 1000).toISOString();
        pull.mergeCommitSha = mergeSha;
        store.bump(repo);
        return json(200, { sha: mergeSha, merged: true, message: `Pull request #${pull.number} merged` });
      }
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
