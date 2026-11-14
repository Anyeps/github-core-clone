// Minimal GraphQL executor for exactly the documents the suite sends (gh CLI + the
// github-mcp-server shapes): viewer, repository(+issue/issues/pullRequests/pullRequest),
// node(id:), __type introspection, and the five mutations. Unknown fields produce a
// 200 with errors[] naming the field; unknown repositories read data.repository = null.

import type { Issue, Pull, Repo, Store } from './store.ts';
import { VIEWER_ID, VIEWER_LOGIN, globalId } from './store.ts';
import { buildCommit, buildTree, flattenTree, putObject, treeOfCommit } from './git-objects.ts';

// -------------------------------------------------------------------------------- parser

type Value = string | number | boolean | null | Value[] | { [k: string]: Value };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  children: FieldNode[];
}

interface Operation {
  kind: 'query' | 'mutation';
  fields: FieldNode[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():![]=$'.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const n = src[j + 1] as string;
          out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j] as string)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];
  private readonly variables: Record<string, Value>;

  constructor(tokens: string[], variables: Record<string, Value>) {
    this.tokens = tokens;
    this.variables = variables;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    return this.tokens[this.pos++] as string;
  }

  expect(tok: string): void {
    if (this.next() !== tok) throw new Error(`expected ${tok}`);
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let tok = this.peek();
    if (tok === 'query' || tok === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
      tok = this.peek();
      if (tok !== undefined && tok !== '{' && tok !== '(') this.next(); // operation name
      if (this.peek() === '(') this.skipParens();
    }
    return { kind, fields: this.parseSelectionSet() };
  }

  private skipParens(): void {
    let depth = 0;
    for (;;) {
      const t = this.next();
      if (t === '(') depth += 1;
      else if (t === ')') {
        depth -= 1;
        if (depth === 0) return;
      } else if (t === undefined) return;
    }
  }

  parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}' && this.peek() !== undefined) {
      fields.push(...this.parseField());
    }
    this.expect('}');
    return fields;
  }

  private parseField(): FieldNode[] {
    let tok = this.next();
    if (tok === '...') {
      // Inline fragment: `... on Type { ... }` (fragment spreads are not used).
      if (this.peek() === 'on') {
        this.next();
        const typeName = this.next();
        const children = this.parseSelectionSet();
        return [{ alias: null, name: `...on:${typeName}`, args: {}, children }];
      }
      this.next(); // fragment name (unsupported, skip its selection set if any)
      if (this.peek() === '{') this.parseSelectionSet();
      return [];
    }
    let alias: string | null = null;
    let name = tok;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Record<string, Value> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.peek() !== undefined) {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    const children = this.peek() === '{' ? this.parseSelectionSet() : [];
    return [{ alias, name, args, children }];
  }

  private parseValue(): Value {
    const tok = this.next();
    if (tok === '$') {
      const name = this.next();
      return this.variables[name] ?? null;
    }
    if (tok === '[') {
      const list: Value[] = [];
      while (this.peek() !== ']' && this.peek() !== undefined) list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (tok === '{') {
      const obj: Record<string, Value> = {};
      while (this.peek() !== '}' && this.peek() !== undefined) {
        const key = this.next();
        this.expect(':');
        obj[key] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    if (tok !== undefined && tok.startsWith('"')) return JSON.parse(tok) as string;
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    const num = Number(tok);
    if (tok !== undefined && tok !== '' && Number.isFinite(num)) return num;
    return tok ?? null; // enum value: bare name as a string
  }
}

// -------------------------------------------------------------------------------- schema data

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'url', 'user', 'labels', 'comments'];
const PR_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'createdAt', 'url'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'];
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ISSUE_FIELDS,
  PullRequest: PR_FIELDS,
  Repository: REPO_FIELDS,
  SearchType: [],
  User: ['id', 'login', 'name'],
  IssueComment: ['id', 'body', 'createdAt'],
};
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];

interface ExecCtx {
  store: Store;
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.id);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.id}:${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', `${repo.id}:${pull.number}`);
}

function decodeGlobalId(id: string): { kind: string; rest: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    return { kind: text.slice(0, colon), rest: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function findRepoByGlobalId(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const dbId = Number(decoded.rest);
  return store.reposById.get(dbId) ?? null;
}

function cursorFor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function cursorToNumber(cursor: string | undefined): number | null {
  if (cursor === undefined) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice(7));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------- execution

type NodeValue =
  | { __type: string; repo: Repo }
  | { __type: string; issue: Issue; repo: Repo }
  | { __type: string; pull: Pull; repo: Repo }
  | { __type: string; user: true }
  | { __type: string; comment: { id: number; body: string }; repo: Repo }
  | { __type: string; connection: unknown[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } }
  | { __type: string; typeName: string }
  | { __type: string; refName: string }
  | { __type: string; edge: { id: number; body: string }; repo: Repo }
  | null;

class Executor {
  private errors: Array<{ message: string }> = [];
  private readonly ctx: ExecCtx;
  private readonly variables: Record<string, Value>;

  constructor(ctx: ExecCtx, variables: Record<string, Value>) {
    this.ctx = ctx;
    this.variables = variables;
  }

  run(op: Operation): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
    const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
    const data: Record<string, unknown> = {};
    for (const field of op.fields) {
      const value = this.resolveField(rootType, null, field);
      data[field.alias ?? field.name] = value;
    }
    const out: { data: Record<string, unknown>; errors?: Array<{ message: string }> } = { data };
    if (this.errors.length > 0) out.errors = this.errors;
    return out;
  }

  private fieldError(type: string, name: string): void {
    this.errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
  }

  private resolveField(type: string, value: NodeValue, field: FieldNode): unknown {
    if (field.name.startsWith('...on:')) {
      const want = field.name.slice(6);
      const actual = value === null ? null : value.__type;
      if (actual !== want) return undefined;
      const out: Record<string, unknown> = {};
      for (const child of field.children) {
        const v = this.resolveField(type, value, child);
        if (v !== undefined) out[child.alias ?? child.name] = v;
      }
      return out;
    }
    if (field.name === '__typename') return type;
    const resolved = this.resolve(type, value, field);
    if (resolved === undefined) {
      this.fieldError(type, field.name);
      return null;
    }
    return this.shape(type, value, field, resolved);
  }

  /** Resolve a field to a raw value (or undefined when the field does not exist). */
  private resolve(type: string, value: NodeValue, field: FieldNode): unknown {
    const args = field.args;
    if (value !== null && typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
      const t = (value as unknown as { __type: string }).__type;
      if (t.endsWith('Payload')) {
        const fn = PAYLOAD_FIELDS[t]?.[field.name];
        if (fn !== undefined) return fn(value);
        return undefined;
      }
    }
    if (type === 'Query') {
      if (field.name === 'viewer') return { __type: 'User', user: true } as NodeValue;
      if (field.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = this.ctx.store.getRepo(owner, name);
        return repo === null ? null : ({ __type: 'Repository', repo } as NodeValue);
      }
      if (field.name === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = this.ctx.store.reposById.get(Number(decoded.rest));
          return repo === undefined ? null : ({ __type: 'Repository', repo } as NodeValue);
        }
        if (decoded.kind === 'Issue') {
          const [repoId, num] = decoded.rest.split(':');
          const repo = this.ctx.store.reposById.get(Number(repoId));
          const issue = repo?.issues.get(Number(num));
          return repo !== undefined && issue !== undefined ? ({ __type: 'Issue', issue, repo } as NodeValue) : null;
        }
        if (decoded.kind === 'PullRequest') {
          const [repoId, num] = decoded.rest.split(':');
          const repo = this.ctx.store.reposById.get(Number(repoId));
          const pull = repo?.pulls.get(Number(num));
          return repo !== undefined && pull !== undefined ? ({ __type: 'PullRequest', pull, repo } as NodeValue) : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (TYPE_FIELDS[name] === undefined && name !== 'SearchType') return null;
        return { __type: '__Type', typeName: name } as NodeValue;
      }
      return undefined;
    }
    if (type === 'Mutation') {
      return this.resolveMutation(field);
    }
    if (value === null) return null;
    if (type === 'User') {
      if (field.name === 'login') return VIEWER_LOGIN;
      if (field.name === 'id') return globalId('User', VIEWER_ID);
      if (field.name === 'name') return 'ada iversen';
      return undefined;
    }
    if (type === 'Repository' && value.__type === 'Repository') {
      const repo = value.repo;
      switch (field.name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return { __type: 'User', user: true } as NodeValue;
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip === undefined ? null : ({ __type: 'Ref', refName: repo.defaultBranch } as NodeValue);
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number ?? 0));
          return issue === undefined ? null : ({ __type: 'Issue', issue, repo } as NodeValue);
        }
        case 'issues': {
          let list = [...repo.issues.values()];
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states !== null) {
            const wanted = new Set(states.map((s) => String(s).toLowerCase()));
            list = list.filter((i) => wanted.has(i.state));
          }
          const orderBy = (args.orderBy ?? {}) as Record<string, Value>;
          if (String(orderBy.field ?? '') === 'CREATED_AT') {
            const dir = String(orderBy.direction ?? 'DESC');
            list.sort((a, b) => (dir === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
          } else {
            list.sort((a, b) => a.seq - b.seq);
          }
          const afterNum = cursorToNumber(args.after as string | undefined);
          if (afterNum !== null) {
            const dir = String(((args.orderBy ?? {}) as Record<string, Value>).direction ?? '');
            list = dir === 'DESC' ? list.filter((i) => i.number < afterNum) : list.filter((i) => i.number > afterNum);
          }
          const first = Number(args.first ?? 100);
          const page = list.slice(0, first).map((issue) => ({ __type: 'Issue', issue, repo }) as NodeValue);
          const hasNext = list.length > first;
          const endCursor = page.length > 0 ? cursorFor((page[page.length - 1] as unknown as { issue: Issue }).issue.number) : null;
          return { __type: 'IssueConnection', connection: page, pageInfo: { hasNextPage: hasNext, endCursor } } as NodeValue;
        }
        case 'pullRequests': {
          let list = [...repo.pulls.values()];
          list.sort((a, b) => b.seq - a.seq);
          const first = Number(args.first ?? 100);
          const page = list.slice(0, first).map((pull) => ({ __type: 'PullRequest', pull, repo }) as NodeValue);
          return { __type: 'PullRequestConnection', connection: page, pageInfo: { hasNextPage: list.length > first, endCursor: null } } as NodeValue;
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number ?? 0));
          return pull === undefined ? null : ({ __type: 'PullRequest', pull, repo } as NodeValue);
        }
        default:
          return undefined;
      }
    }
    if (type === 'Issue' && value.__type === 'Issue') {
      const issue = value.issue;
      const repo = value.repo;
      switch (field.name) {
        case 'id':
          return issueGlobalId(repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'createdAt':
          return issue.createdAt;
        case 'url':
          return `/${repo.owner}/${repo.name}/issues/${issue.number}`;
        default:
          return undefined;
      }
    }
    if (type === 'PullRequest' && value.__type === 'PullRequest') {
      const pull = value.pull;
      const repo = value.repo;
      switch (field.name) {
        case 'id':
          return pullGlobalId(repo, pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          return mergeableOf(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'files': {
          const files = pullFilesList(repo, pull);
          return { __type: 'FileConnection', connection: files } as NodeValue;
        }
        case 'createdAt':
          return pull.createdAt;
        case 'url':
          return `/${repo.owner}/${repo.name}/pulls/${pull.number}`;
        default:
          return undefined;
      }
    }
    if (type === 'Ref' && value.__type === 'Ref') {
      if (field.name === 'name') return value.refName;
      return undefined;
    }
    if (type === 'IssueConnection' && value.__type === 'IssueConnection') {
      if (field.name === 'nodes') return value.connection;
      if (field.name === 'pageInfo') return value.pageInfo ?? { hasNextPage: false, endCursor: null };
      if (field.name === 'totalCount') return (value.connection as unknown[]).length;
      return undefined;
    }
    if (type === 'PullRequestConnection' && value.__type === 'PullRequestConnection') {
      if (field.name === 'nodes') return value.connection;
      if (field.name === 'pageInfo') return value.pageInfo ?? { hasNextPage: false, endCursor: null };
      if (field.name === 'totalCount') return (value.connection as unknown[]).length;
      return undefined;
    }
    if (type === 'PageInfo') {
      const info = value as unknown as { hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'hasNextPage') return info.hasNextPage;
      if (field.name === 'endCursor') return info.endCursor;
      return undefined;
    }
    if (type === 'FileConnection' && value.__type === 'FileConnection') {
      if (field.name === 'nodes') return value.connection;
      if (field.name === 'totalCount') return (value.connection as unknown[]).length;
      return undefined;
    }
    if (type === 'File') {
      const file = value as unknown as { path: string };
      if (field.name === 'path') return file.path;
      return undefined;
    }
    if (type === '__Type' && value.__type === '__Type') {
      const name = value.typeName;
      if (field.name === 'name') return name;
      if (field.name === 'fields') {
        const names = TYPE_FIELDS[name] ?? [];
        return names.map((n) => ({ __type: '__Field', name: n }) as NodeValue);
      }
      if (field.name === 'enumValues') {
        if (name !== 'SearchType') return [];
        return SEARCH_TYPE_VALUES.map((n) => ({ __type: '__EnumValue', name: n }) as NodeValue);
      }
      return undefined;
    }
    if (type === '__Field' && value.__type === '__Field') {
      const f = value as unknown as { name: string };
      if (field.name === 'name') return f.name;
      if (field.name === 'description') return '';
      if (field.name === 'type') return { kind: 'SCALAR', name: 'String' };
      return undefined;
    }
    if (type === '__EnumValue' && value.__type === '__EnumValue') {
      const f = value as unknown as { name: string };
      if (field.name === 'name') return f.name;
      if (field.name === 'description') return '';
      return undefined;
    }
    if (type === 'IssueComment' && value.__type === 'IssueComment') {
      const c = value as unknown as { comment: { id: number; body: string } };
      if (field.name === 'id') return globalId('IssueComment', c.comment.id);
      if (field.name === 'body') return c.comment.body;
      return undefined;
    }
    if (type === 'CommentEdge' && value.__type === 'CommentEdge') {
      if (field.name === 'node') return { __type: 'IssueComment', comment: (value as unknown as { edge: { id: number; body: string } }).edge } as NodeValue;
      return undefined;
    }
    return undefined;
  }

  /** Shape a resolved value against the field's selection set. */
  private shape(type: string, value: NodeValue, field: FieldNode, resolved: unknown): unknown {
    if (resolved === null || resolved === undefined) return resolved;
    if (field.children.length === 0) return resolved;
    if (Array.isArray(resolved)) {
      const itemType = type === 'PullRequestConnection' ? 'PullRequest' : type === 'FileConnection' ? 'File' : type === '__Type' ? '__Field' : 'Issue';
      return resolved.map((item) => {
        const node = item as NodeValue;
        const out: Record<string, unknown> = {};
        const childType = node !== null && typeof node === 'object' && '__type' in (node as Record<string, unknown>)
          ? (node as unknown as { __type: string }).__type
          : itemType;
        for (const child of field.children) {
          const v = this.resolveField(childType, node, child);
          if (v === undefined) continue;
          if (child.name.startsWith('...on:')) {
            if (isRecord(v)) Object.assign(out, v);
          } else {
            out[child.alias ?? child.name] = v;
          }
        }
        return out;
      });
    }
    if (typeof resolved === 'object') {
      const node = resolved as NodeValue;
      const childType = this.childType(type, field, node);
      const out: Record<string, unknown> = {};
      for (const child of field.children) {
        const v = this.resolveField(childType, node, child);
        if (v === undefined) continue;
        if (child.name.startsWith('...on:')) {
          if (isRecord(v)) Object.assign(out, v);
        } else {
          out[child.alias ?? child.name] = v;
        }
      }
      return out;
    }
    return resolved;
  }

  private childType(parentType: string, field: FieldNode, node: NodeValue): string {
    if (node !== null && typeof node === 'object' && '__type' in (node as Record<string, unknown>)) {
      const t = (node as unknown as { __type: string }).__type;
      if (t.endsWith('Payload')) return t;
      if (t === 'IssueConnection') return 'IssueConnection';
      if (t === 'PullRequestConnection') return 'PullRequestConnection';
      if (t === 'FileConnection') return 'FileConnection';
      if (t === 'User') return 'User';
      if (t === 'Repository') return 'Repository';
      if (t === 'Issue') return 'Issue';
      if (t === 'PullRequest') return 'PullRequest';
      if (t === 'Ref') return 'Ref';
      if (t === '__Type') return '__Type';
      if (t === '__Field') return '__Field';
      if (t === '__EnumValue') return '__EnumValue';
      if (t === 'IssueComment') return 'IssueComment';
      if (t === 'CommentEdge') return 'CommentEdge';
    }
    if (field.name === 'pageInfo') return 'PageInfo';
    if (field.name === 'nodes') {
      if (parentType === 'IssueConnection') return 'Issue';
      if (parentType === 'PullRequestConnection') return 'PullRequest';
      if (parentType === 'FileConnection') return 'File';
    }
    if (field.name === 'node' && parentType === 'CommentEdge') return 'IssueComment';
    return parentType;
  }

  // -------------------------------------------------------------------------------- mutations

  private resolveMutation(field: FieldNode): unknown {
    const store = this.ctx.store;
    const input = (field.args.input ?? {}) as Record<string, Value>;
    if (field.name === 'createIssue') {
      const repo = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
      if (repo === null) {
        this.errors.push({ message: 'Repository not found.' });
        return null;
      }
      const labelsRaw = Array.isArray(input.labels) ? (input.labels as string[]) : [];
      for (const l of labelsRaw) {
        if (!repo.labels.has(l)) {
          this.errors.push({ message: `Label "${l}" does not exist.` });
          return null;
        }
      }
      const now = store.clock.nextIso();
      const number = repo.nextNumber++;
      const issue: Issue = {
        number,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: labelsRaw,
        user: VIEWER_LOGIN,
        createdAt: now,
        updatedAt: now,
        seq: number,
        comments: [],
      };
      repo.issues.set(number, issue);
      return { __type: 'CreateIssuePayload', issue, repo } as unknown as NodeValue;
    }
    if (field.name === 'closeIssue') {
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (decoded === null || decoded.kind !== 'Issue') {
        this.errors.push({ message: 'Issue not found.' });
        return null;
      }
      const [repoId, num] = decoded.rest.split(':');
      const repo = store.reposById.get(Number(repoId));
      const issue = repo?.issues.get(Number(num));
      if (repo === undefined || issue === undefined) {
        this.errors.push({ message: 'Issue not found.' });
        return null;
      }
      issue.state = 'closed';
      issue.updatedAt = store.clock.nextIso();
      return { __type: 'CloseIssuePayload', issue, repo } as unknown as NodeValue;
    }
    if (field.name === 'createPullRequest') {
      const repo = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
      if (repo === null) {
        this.errors.push({ message: 'Repository not found.' });
        return null;
      }
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) {
        this.errors.push({ message: 'head or base branch does not exist.' });
        return null;
      }
      for (const p of repo.pulls.values()) {
        if (p.state === 'open' && p.headRef === head && p.baseRef === base) {
          this.errors.push({ message: 'A pull request already exists for these branches.' });
          return null;
        }
      }
      const now = store.clock.nextIso();
      const number = repo.nextNumber++;
      const pull: Pull = {
        number,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
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
        seq: number,
      };
      repo.pulls.set(number, pull);
      return { __type: 'CreatePullRequestPayload', pull, repo } as unknown as NodeValue;
    }
    if (field.name === 'mergePullRequest') {
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (decoded === null || decoded.kind !== 'PullRequest') {
        this.errors.push({ message: 'Pull request not found.' });
        return null;
      }
      const [repoId, num] = decoded.rest.split(':');
      const repo = store.reposById.get(Number(repoId));
      const pull = repo?.pulls.get(Number(num));
      if (repo === undefined || pull === undefined) {
        this.errors.push({ message: 'Pull request not found.' });
        return null;
      }
      if (pull.state !== 'open') {
        this.errors.push({ message: 'Pull request is not open.' });
        return null;
      }
      const merged = mergePullRequest(store, repo, pull);
      if (!merged) {
        this.errors.push({ message: 'Merge conflict.' });
        return { __type: 'MergePullRequestPayload', pull, repo } as unknown as NodeValue;
      }
      return { __type: 'MergePullRequestPayload', pull, repo } as unknown as NodeValue;
    }
    if (field.name === 'addComment') {
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (decoded === null || decoded.kind !== 'Issue') {
        this.errors.push({ message: 'Subject not found.' });
        return null;
      }
      const [repoId, num] = decoded.rest.split(':');
      const repo = store.reposById.get(Number(repoId));
      const issue = repo?.issues.get(Number(num));
      if (repo === undefined || issue === undefined) {
        this.errors.push({ message: 'Subject not found.' });
        return null;
      }
      const comment = { id: repo.nextCommentId++, body: String(input.body ?? ''), user: VIEWER_LOGIN, createdAt: store.clock.nextIso() };
      issue.comments.push(comment);
      return { __type: 'AddCommentPayload', edge: comment, repo } as unknown as NodeValue;
    }
    return undefined;
  }
}

// Payload shaping: the mutation payloads expose issue/pullRequest/commentEdge.
const PAYLOAD_FIELDS: Record<string, Record<string, (v: NodeValue) => unknown>> = {
  CreateIssuePayload: {
    issue: (v) => ({ __type: 'Issue', issue: (v as unknown as { issue: Issue }).issue, repo: (v as unknown as { repo: Repo }).repo }) as NodeValue,
  },
  CloseIssuePayload: {
    issue: (v) => ({ __type: 'Issue', issue: (v as unknown as { issue: Issue }).issue, repo: (v as unknown as { repo: Repo }).repo }) as NodeValue,
  },
  CreatePullRequestPayload: {
    pullRequest: (v) => ({ __type: 'PullRequest', pull: (v as unknown as { pull: Pull }).pull, repo: (v as unknown as { repo: Repo }).repo }) as NodeValue,
  },
  MergePullRequestPayload: {
    pullRequest: (v) => ({ __type: 'PullRequest', pull: (v as unknown as { pull: Pull }).pull, repo: (v as unknown as { repo: Repo }).repo }) as NodeValue,
  },
  AddCommentPayload: {
    commentEdge: (v) => ({ __type: 'CommentEdge', edge: (v as unknown as { edge: { id: number; body: string } }).edge, repo: (v as unknown as { repo: Repo }).repo }) as NodeValue,
  },
};


function mergeableOf(repo: Repo, pull: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return false;
  const baseTree = treeOfCommit(repo, pull.baseSha);
  const headTree = treeOfCommit(repo, pull.headSha);
  const currentTree = treeOfCommit(repo, baseTip);
  const base = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const head = headTree === null ? new Map() : flattenTree(repo, headTree);
  const cur = currentTree === null ? new Map() : flattenTree(repo, currentTree);
  const same = (a: { oid: string } | undefined, b: { oid: string } | undefined): boolean => (a?.oid ?? null) === (b?.oid ?? null);
  for (const path of new Set([...base.keys(), ...head.keys()])) {
    const b = base.get(path);
    const h = head.get(path);
    const c = cur.get(path);
    if (same(h, b)) continue;
    if (same(c, b)) continue;
    if (same(h, c)) continue;
    return false;
  }
  return true;
}

function pullFilesList(repo: Repo, pull: Pull): Array<{ path: string }> {
  const baseTree = treeOfCommit(repo, pull.baseSha);
  const headTree = treeOfCommit(repo, pull.headSha);
  const base = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const head = headTree === null ? new Map() : flattenTree(repo, headTree);
  const out: Array<{ path: string }> = [];
  for (const path of [...new Set([...base.keys(), ...head.keys()])].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    out.push({ path });
  }
  return out;
}

/** Shared squash-merge used by REST and GraphQL; returns false on conflict. */
export function mergePullRequest(store: Store, repo: Repo, pull: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return false;
  if (!mergeableOf(repo, pull)) return false;
  const baseTree = treeOfCommit(repo, pull.baseSha);
  const headTree = treeOfCommit(repo, pull.headSha);
  const currentTree = treeOfCommit(repo, baseTip);
  const base = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const head = headTree === null ? new Map() : flattenTree(repo, headTree);
  const cur = currentTree === null ? new Map() : flattenTree(repo, currentTree);
  const merged = new Map(cur);
  for (const path of new Set([...base.keys(), ...head.keys()])) {
    const b = base.get(path);
    const h = head.get(path);
    const c = cur.get(path);
    if ((h?.oid ?? null) === (b?.oid ?? null)) continue;
    if ((c?.oid ?? null) === (b?.oid ?? null)) {
      if (h === undefined) merged.delete(path);
      else merged.set(path, h);
    }
  }
  // Rebuild the tree from the merged flat map.
  const treeOid = buildTreeFromFlat(repo, merged);
  const sec = store.clock.nextSec();
  const ident = `ada iversen <adaiversen@example.invalid> ${sec} +0000`;
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
  const commitData = buildCommit({ tree: treeOid, parents: [baseTip], author: ident, committer: ident, message });
  const mergeSha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date(sec * 1000).toISOString();
  pull.mergeCommitSha = mergeSha;
  store.bump(repo);
  return true;
}

function buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
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

// -------------------------------------------------------------------------------- entry point

export interface GraphQLResult {
  status: number;
  body: unknown;
}

export function handleGraphQL(store: Store, body: unknown): GraphQLResult {
  const ops = Array.isArray(body) ? body : [body];
  const results: unknown[] = [];
  for (const op of ops) {
    const raw = (op ?? {}) as Record<string, unknown>;
    const query = typeof raw.query === 'string' ? raw.query : '';
    const variables = (raw.variables ?? {}) as Record<string, Value>;
    if (query.trim() === '') {
      results.push({ data: null, errors: [{ message: 'No query was provided.' }] });
      continue;
    }
    try {
      const parser = new Parser(tokenize(query), variables);
      const operation = parser.parseOperation();
      const executor = new Executor({ store }, variables);
      results.push(executor.run(operation));
    } catch (err) {
      results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error.' }] });
    }
  }
  return { status: 200, body: Array.isArray(body) ? results : results[0] };
}

