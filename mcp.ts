// MCP endpoint (POST /mcp): JSON-RPC 2.0 over Streamable HTTP, answered as plain JSON.
// Modern era (2026-07-28) via server/discover, with the legacy initialize as a safety net.
// tools/list is byte-identical across calls: the tools array is built once at load.

import type { Repo, Store } from './store.ts';
import { VIEWER_ID, VIEWER_LOGIN } from './store.ts';
import { mergePullRequest } from './graphql.ts';

export interface McpResult {
  status: number;
  body: unknown;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SERVER_INFO = { name: 'forge', version: '1.0.0' };

function repoView(repo: Repo): Record<string, unknown> {
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
  };
}

function issueView(repo: Repo, issue: Repo['issues'] extends Map<number, infer V> ? V : never): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((n) => ({ name: n })),
    user: { login: issue.user, id: VIEWER_ID, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullView(repo: Repo, pull: Repo['pulls'] extends Map<number, infer V> ? V : never): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pull.number,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    created_at: pull.createdAt,
  };
}

type ToolOutcome = { ok: true; value: unknown } | { ok: false; message: string };

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const getRepoArg = (a: Record<string, unknown>): Repo | null => {
    let owner = str(a.owner);
    let repoName = str(a.repo);
    if ((owner === '' || repoName === '') && typeof a.full_name === 'string') {
      const parts = (a.full_name as string).split('/');
      if (parts.length === 2) {
        owner = parts[0] as string;
        repoName = parts[1] as string;
      }
    }
    if (owner === '' || repoName === '') return null;
    return store.getRepo(owner, repoName);
  };

  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      if (repoName === '') return { ok: false, message: 'name is required' };
      const created = store.createRepo(repoName, {
        description: str(args.description),
        private: args.private === true,
      });
      if (created === null) return { ok: false, message: 'name already exists on this account' };
      return { ok: true, value: repoView(created) };
    }
    case 'get_repo': {
      const repo = getRepoArg(args);
      if (repo === null) return { ok: false, message: 'Not Found' };
      return { ok: true, value: repoView(repo) };
    }
    case 'create_issue': {
      const repo = getRepoArg(args);
      if (repo === null) return { ok: false, message: 'Not Found' };
      const title = str(args.title);
      if (title === '') return { ok: false, message: 'title is required' };
      const now = store.clock.nextIso();
      const number = repo.nextNumber++;
      const issue = {
        number,
        title,
        body: str(args.body),
        state: 'open' as const,
        labels: [] as string[],
        user: VIEWER_LOGIN,
        createdAt: now,
        updatedAt: now,
        seq: number,
        comments: [] as Array<{ id: number; body: string; user: string; createdAt: string }>,
      };
      repo.issues.set(number, issue);
      return { ok: true, value: issueView(repo, issue) };
    }
    case 'list_issues': {
      const repo = getRepoArg(args);
      if (repo === null) return { ok: false, message: 'Not Found' };
      const state = str(args.state) || 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => b.seq - a.seq);
      const value = { issues: list.map((i) => issueView(repo, i)) };
      return { ok: true, value };
    }
    case 'create_pull_request': {
      const repo = getRepoArg(args);
      if (repo === null) return { ok: false, message: 'Not Found' };
      const title = str(args.title);
      const head = str(args.head);
      const base = str(args.base);
      if (title === '' || head === '' || base === '') return { ok: false, message: 'title, head and base are required' };
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return { ok: false, message: 'head or base branch does not exist' };
      for (const p of repo.pulls.values()) {
        if (p.state === 'open' && p.headRef === head && p.baseRef === base) {
          return { ok: false, message: 'A pull request already exists for these branches' };
        }
      }
      const now = store.clock.nextIso();
      const number = repo.nextNumber++;
      const pull = {
        number,
        title,
        body: str(args.body),
        state: 'open' as const,
        merged: false,
        mergedAt: null as string | null,
        mergeCommitSha: null as string | null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        user: VIEWER_LOGIN,
        createdAt: now,
        seq: number,
      };
      repo.pulls.set(number, pull);
      return { ok: true, value: pullView(repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = getRepoArg(args);
      if (repo === null) return { ok: false, message: 'Not Found' };
      const rawNum = args.pull_number ?? args.number ?? args.pullNumber;
      const number = Number(rawNum);
      if (!Number.isInteger(number) || number < 1) return { ok: false, message: 'pull_number is required' };
      const pull = repo.pulls.get(number);
      if (pull === undefined) return { ok: false, message: 'Not Found' };
      if (pull.state !== 'open') return { ok: false, message: 'Pull request is not open' };
      const merged = mergePullRequest(store, repo, pull);
      if (!merged) return { ok: false, message: 'Merge conflict' };
      return { ok: true, value: { merged: true, sha: pull.mergeCommitSha, number: pull.number, state: pull.state } };
    }
    default:
      return { ok: false, message: `unknown tool ${name}` };
  }
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export function handleMcp(store: Store, rawBody: Buffer): McpResult {
  const text = rawBody.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Parse error: echo the id if one is visible in the raw text.
    const m = text.match(/"id"\s*:\s*("[^"]*"|\d+)/);
    let id: unknown = null;
    if (m !== null) {
      const raw = m[1] as string;
      id = raw.startsWith('"') ? raw.slice(1, -1) : Number(raw);
    }
    return { status: 400, body: rpcError(id, -32700, 'Parse error') };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const req = parsed as Record<string, unknown>;
  const id = req.id ?? null;
  const hasId = req.id !== undefined;
  const method = typeof req.method === 'string' ? req.method : '';
  // Notifications (no id) are answered 202 with an empty body.
  if (!hasId) {
    return { status: 202, body: null };
  }
  if (method === 'server/discover') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: ['2026-07-28', '2025-11-25'],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        },
      },
    };
  }
  if (method === 'initialize') {
    const params = (req.params ?? {}) as Record<string, unknown>;
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      },
    };
  }
  if (method === 'ping') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
  }
  if (method === 'tools/list') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: { tools: TOOLS } } };
  }
  if (method === 'tools/call') {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (toolName === '') return { status: 200, body: rpcError(id, -32602, 'tool name is required') };
    const known = TOOLS.some((t) => t.name === toolName);
    if (!known) return { status: 200, body: rpcError(id, -32602, `unknown tool ${toolName}`) };
    const outcome = callTool(store, toolName, args);
    if (!outcome.ok) {
      const textOut = JSON.stringify({ error: outcome.message });
      return {
        status: 200,
        body: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: textOut }], structuredContent: { error: outcome.message }, isError: true } },
      };
    }
    const textOut = JSON.stringify(outcome.value);
    return {
      status: 200,
      body: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: textOut }], structuredContent: outcome.value, isError: false } },
    };
  }
  return { status: 200, body: rpcError(id, -32601, `method not found: ${method}`) };
}
