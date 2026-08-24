import { TOOLS, getModelDescription, type ToolDefinition } from '../types.js';

export const toolDefinitions: ToolDefinition[] = [
  {
    name: TOOLS.CODEX,
    description: 'Execute Codex CLI in non-interactive mode for AI assistance',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The coding task, question, or analysis request',
        },
        sessionId: {
          type: 'string',
          description:
            'Optional session ID for conversational context. Note: when resuming a session, sandbox/fullAuto/workingDirectory parameters are not applied (CLI limitation)',
        },
        resetSession: {
          type: 'boolean',
          description:
            'Reset the session history before processing this request',
        },
        model: {
          type: 'string',
          description: getModelDescription('codex'),
        },
        reasoningEffort: {
          type: 'string',
          enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
          description:
            'Control reasoning depth (none < minimal < low < medium < high < xhigh)',
        },
        sandbox: {
          type: 'string',
          enum: ['read-only', 'workspace-write', 'danger-full-access'],
          description:
            'Sandbox policy for shell command execution. read-only: no writes allowed, workspace-write: writes only in workspace, danger-full-access: full system access (dangerous)',
        },
        fullAuto: {
          type: 'boolean',
          description:
            'Enable full-auto mode: sandboxed automatic execution without approval prompts (equivalent to -a on-request --sandbox workspace-write)',
        },
        workingDirectory: {
          type: 'string',
          description:
            'Working directory for the agent to use as its root (passed via -C flag)',
        },
        callbackUri: {
          type: 'string',
          description:
            'Static MCP callback URI to pass to Codex via environment (if provided)',
        },
      },
      required: ['prompt'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
      },
    },
    annotations: {
      title: 'Execute Codex CLI',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: TOOLS.CODEX_START,
    description:
      'Start a Codex CLI execution WITHOUT waiting for it to finish. Returns a jobId immediately (background dispatch, analogous to Claude Code\'s Agent tool with run_in_background). No sessionId support (fire-and-forget only) and no automatic completion notification is possible over this transport — poll with codexJobStatus or codexJobList to check progress/results.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The coding task, question, or analysis request',
        },
        model: {
          type: 'string',
          description: getModelDescription('codex'),
        },
        reasoningEffort: {
          type: 'string',
          enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
          description:
            'Control reasoning depth (none < minimal < low < medium < high < xhigh)',
        },
        sandbox: {
          type: 'string',
          enum: ['read-only', 'workspace-write', 'danger-full-access'],
          description:
            'Sandbox policy for shell command execution. read-only: no writes allowed, workspace-write: writes only in workspace, danger-full-access: full system access (dangerous)',
        },
        fullAuto: {
          type: 'boolean',
          description:
            'Enable full-auto mode: sandboxed automatic execution without approval prompts',
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for the agent to use as its root (passed via -C flag)',
        },
      },
      required: ['prompt'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        status: { type: 'string' },
      },
    },
    annotations: {
      title: 'Start Codex Job (async)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: TOOLS.CODEX_JOB_STATUS,
    description:
      'Check the status of a job started with codexStart. Returns "running" until the process exits, then "completed" (with stdout/stderr) or "failed" (with an error message).',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'The jobId returned by codexStart',
        },
      },
      required: ['jobId'],
    },
    annotations: {
      title: 'Check Codex Job Status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: TOOLS.CODEX_JOB_LIST,
    description:
      'List all background jobs started with codexStart (running, completed, and failed), newest first.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    annotations: {
      title: 'List Codex Jobs',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: TOOLS.REVIEW,
    description:
      'Run a code review against the current repository using Codex CLI',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'Custom review instructions or focus areas. Cannot be combined with uncommitted, base, or commit — the underlying codex CLI rejects `review --base/--commit <PROMPT>` and `review --uncommitted <PROMPT>` at the argument-parsing level (verified empirically). Use prompt alone: it can instruct Codex to read a diff file itself via its own file-read capability (pass workingDirectory so it can resolve relative paths). Or omit prompt and use base/commit/uncommitted for a plain diff review with no custom instructions.',
        },
        uncommitted: {
          type: 'boolean',
          description:
            'Review staged, unstaged, and untracked changes (working tree) - cannot be combined with custom prompt',
        },
        base: {
          type: 'string',
          description:
            'Review changes against a specific base branch (e.g., "main", "develop") - cannot be combined with custom prompt',
        },
        commit: {
          type: 'string',
          description:
            'Review the changes introduced by a specific commit SHA - cannot be combined with custom prompt',
        },
        title: {
          type: 'string',
          description: 'Optional title to display in the review summary',
        },
        model: {
          type: 'string',
          description: getModelDescription('review'),
        },
        workingDirectory: {
          type: 'string',
          description:
            'Working directory to run the review in (passed via -C as a global Codex option)',
        },
        planId: {
          type: 'string',
          description:
            'Fork-local: correlate this review to a plan (e.g. the plan file slug) for reviewStatus/reviewList lookups. Purely a tracking tag — never interpreted.',
        },
        taskId: {
          type: 'string',
          description:
            'Fork-local: correlate this review to a task number within the plan. Tracking tag only.',
        },
        round: {
          type: 'number',
          description:
            'Fork-local: fix-loop round number, for re-review calls. Tracking tag only.',
        },
        phase: {
          type: 'string',
          enum: ['task-review', 're-review', 'final-review'],
          description:
            'Fork-local: which SDD review touchpoint this call is for. Tracking tag only.',
        },
      },
      required: [],
    },
    annotations: {
      title: 'Code Review',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: TOOLS.REVIEW_STATUS,
    description:
      'Check the status of a review started with review. Returns "running" until the process exits, then "completed" (with the review text) or "failed" (with an error message).',
    inputSchema: {
      type: 'object',
      properties: {
        reviewId: {
          type: 'string',
          description: 'The reviewId returned by review',
        },
      },
      required: ['reviewId'],
    },
    annotations: {
      title: 'Check Review Status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: TOOLS.REVIEW_LIST,
    description:
      'List tracked review calls (running, completed, and failed), newest first. Optionally filter by planId and/or taskId.',
    inputSchema: {
      type: 'object',
      properties: {
        planId: {
          type: 'string',
          description: 'Only list reviews tagged with this planId',
        },
        taskId: {
          type: 'string',
          description: 'Only list reviews tagged with this taskId',
        },
      },
      required: [],
    },
    annotations: {
      title: 'List Reviews',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: TOOLS.PING,
    description: 'Test MCP server connection',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Message to echo back',
        },
      },
      required: [],
    },
    annotations: {
      title: 'Ping Server',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: TOOLS.HELP,
    description: 'Get Codex CLI help information',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    annotations: {
      title: 'Get Help',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: TOOLS.LIST_SESSIONS,
    description: 'List all active conversation sessions with metadata',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    annotations: {
      title: 'List Sessions',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: TOOLS.WEBSEARCH,
    description: 'Perform web search using Codex CLI with web search enabled',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to execute',
        },
        numResults: {
          type: 'integer',
          description: 'Number of search results to return (1-50, default: 10)',
          minimum: 1,
          maximum: 50,
        },
        searchDepth: {
          type: 'string',
          enum: ['basic', 'full'],
          description:
            'Search depth: basic (faster) or full (deeper analysis, default: basic)',
        },
      },
      required: ['query'],
    },
    annotations: {
      title: 'Web Search',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
];
