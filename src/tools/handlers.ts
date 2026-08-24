import {
  TOOLS,
  DEFAULT_CODEX_MODEL,
  DEFAULT_REVIEW_MODEL,
  CODEX_DEFAULT_MODEL_ENV_VAR,
  CODEX_REVIEW_MODEL_ENV_VAR,
  type ToolResult,
  type ToolHandlerContext,
  type CodexToolArgs,
  type CodexStartToolArgs,
  type JobStatusToolArgs,
  type JobListToolArgs,
  type ReviewToolArgs,
  type ReviewStatusToolArgs,
  type ReviewListToolArgs,
  type PingToolArgs,
  type WebSearchToolArgs,
  CodexToolSchema,
  CodexStartToolSchema,
  JobStatusToolSchema,
  JobListToolSchema,
  ReviewToolSchema,
  ReviewStatusToolSchema,
  ReviewListToolSchema,
  PingToolSchema,
  HelpToolSchema,
  ListSessionsToolSchema,
  WebSearchToolSchema,
} from '../types.js';
import {
  InMemorySessionStorage,
  type SessionStorage,
  type ConversationTurn,
} from '../session/storage.js';
import { InMemoryJobStore, type JobStore } from '../jobs/store.js';
import { InMemoryReviewStore, type ReviewStore } from '../tracking/review-store.js';
import { ToolExecutionError, ValidationError } from '../errors.js';
import { executeCommand, executeCommandStreaming } from '../utils/command.js';
import { ZodError } from 'zod';
import path from 'node:path';

// Default no-op context for handlers that don't need progress
const defaultContext: ToolHandlerContext = {
  sendProgress: async () => {},
};

// Fork-local safety note: on Windows, the OS active codepage is frequently
// NOT UTF-8 (e.g. 949/CP949 on Korean-locale systems). Codex CLI's own
// internal file-write tool calls go through this codepage on Windows, which
// can silently corrupt non-ASCII bytes (mojibake) with no error surfaced.
// Verified empirically 2026-08-05: Codex wrote Korean text as mojibake on a
// CP949 system when not told to write UTF-8 explicitly, and wrote it
// correctly once instructed to use an explicit UTF-8-safe method.
//
// This is a probability nudge, not a guarantee (the model can still ignore
// it) — non-ASCII writes must still be verified on disk after the fact
// regardless of whether this note fired. Opt out with
// CODEX_MCP_DISABLE_WIN_UTF8_NOTE=1 (e.g. for ASCII-only projects where the
// per-call overhead isn't worth it).
const WINDOWS_UTF8_SAFETY_NOTE =
  '[Windows] Non-ASCII file writes can get corrupted by the OS codepage. Use an explicit UTF-8 write (PowerShell Set-Content -Encoding UTF8 / Python open(...,encoding="utf-8")), not shell redirection or cmd echo.\n\n';

const withPlatformSafetyNotes = (prompt: string): string =>
  process.platform === 'win32' &&
  process.env.CODEX_MCP_DISABLE_WIN_UTF8_NOTE !== '1'
    ? WINDOWS_UTF8_SAFETY_NOTE + prompt
    : prompt;

const isStructuredContentEnabled = (): boolean => {
  const raw = process.env.STRUCTURED_CONTENT_ENABLED;
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
};

export class CodexToolHandler {
  constructor(private sessionStorage: SessionStorage) {}

  async execute(
    args: unknown,
    context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    try {
      const {
        prompt,
        sessionId,
        resetSession,
        model,
        reasoningEffort,
        sandbox,
        fullAuto,
        workingDirectory,
        callbackUri,
      }: CodexToolArgs = CodexToolSchema.parse(args);

      // Resolve to absolute path once so -C and spawn cwd agree
      const resolvedWorkDir = workingDirectory
        ? path.resolve(workingDirectory)
        : undefined;

      let activeSessionId = sessionId;
      let enhancedPrompt = prompt;

      // Only work with sessions if explicitly requested
      let useResume = false;
      let codexConversationId: string | undefined;

      if (sessionId) {
        this.sessionStorage.ensureSession(sessionId);
        if (resetSession) {
          this.sessionStorage.resetSession(sessionId);
        }

        codexConversationId =
          this.sessionStorage.getCodexConversationId(sessionId);
        if (codexConversationId) {
          useResume = true;
        } else {
          // Fallback to manual context building if no codex conversation ID
          const session = this.sessionStorage.getSession(sessionId);
          if (
            session &&
            Array.isArray(session.turns) &&
            session.turns.length > 0
          ) {
            enhancedPrompt = this.buildEnhancedPrompt(session.turns, prompt);
          }
        }
      }

      // Fork-local: auto-inject the Windows UTF-8 write-safety note (see
      // WINDOWS_UTF8_SAFETY_NOTE above). This tool can write files (unlike
      // review/websearch), so it's the one that needs the warning.
      enhancedPrompt = withPlatformSafetyNotes(enhancedPrompt);

      // Build command arguments with v0.75.0+ features
      const selectedModel =
        model ||
        process.env[CODEX_DEFAULT_MODEL_ENV_VAR] ||
        DEFAULT_CODEX_MODEL;

      const effectiveCallbackUri =
        callbackUri || process.env.CODEX_MCP_CALLBACK_URI;

      let cmdArgs: string[];

      if (useResume && codexConversationId) {
        // Resume mode: codex exec resume has limited flags
        // All exec options (--skip-git-repo-check, -c) must come BEFORE 'resume' subcommand
        cmdArgs = ['exec', '--skip-git-repo-check'];

        // Model must be set via -c config in resume mode (before subcommand)
        cmdArgs.push('-c', `model="${selectedModel}"`);

        // Reasoning effort via config (before subcommand)
        if (reasoningEffort) {
          cmdArgs.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
        }

        // Add resume subcommand with conversation ID and prompt
        cmdArgs.push('resume', codexConversationId, enhancedPrompt);
      } else {
        // Exec mode: supports full set of flags
        cmdArgs = ['exec'];

        // Add model parameter
        cmdArgs.push('--model', selectedModel);

        // Add reasoning effort via config parameter (quoted for consistency)
        if (reasoningEffort) {
          cmdArgs.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
        }

        // Add sandbox mode (v0.75.0+)
        if (sandbox) {
          cmdArgs.push('--sandbox', sandbox);
        }

        // Add full-auto mode (v0.75.0+)
        if (fullAuto) {
          cmdArgs.push('--full-auto');
        }

        // Add working directory (v0.75.0+)
        if (resolvedWorkDir) {
          cmdArgs.push('-C', resolvedWorkDir);
        }

        // Skip git repo check for v0.50.0+
        cmdArgs.push('--skip-git-repo-check');

        cmdArgs.push(enhancedPrompt);
      }

      // Send initial progress notification
      await context.sendProgress('Starting Codex execution...', 0);

      // Use streaming execution if progress is enabled
      const useStreaming = !!context.progressToken;
      const envOverride = effectiveCallbackUri
        ? { CODEX_MCP_CALLBACK_URI: effectiveCallbackUri }
        : undefined;

      // Pass cwd to spawn so the child process starts in the correct directory.
      // This works around openai/codex#9084 where -C is ignored by some subcommands.
      // Skip cwd during resume: sandbox, fullAuto, and workingDirectory are not
      // applied in resume mode (Codex CLI limitation).
      const cmdOptions = {
        cwd: useResume ? undefined : resolvedWorkDir,
        envOverride,
      };

      const result = useStreaming
        ? await executeCommandStreaming('codex', cmdArgs, {
            ...cmdOptions,
            onProgress: (message) => {
              // Send progress notification for each chunk of output
              context.sendProgress(message);
            },
          })
        : await executeCommand('codex', cmdArgs, cmdOptions);

      // Codex CLI may output to stderr, so check both
      const response = result.stdout || result.stderr || 'No output from Codex';

      // Extract conversation/session ID from new conversations for future resume
      // Codex CLI outputs have varied between "session id" and "conversation id"
      if (activeSessionId && !useResume) {
        const conversationIdMatch = result.stderr?.match(
          /(conversation|session)\s*id\s*:\s*([a-zA-Z0-9-]+)/i
        );
        if (conversationIdMatch) {
          this.sessionStorage.setCodexConversationId(
            activeSessionId,
            conversationIdMatch[2]
          );
        }
      }

      const combinedOutput = `${result.stderr || ''}
${result.stdout || ''}`.trim();
      const threadIdMatch = combinedOutput.match(
        /thread\s*id\s*:\s*([a-zA-Z0-9_-]+)/i
      );
      const threadId = threadIdMatch ? threadIdMatch[1] : undefined;

      // Save turn only if using a session
      if (activeSessionId) {
        const turn: ConversationTurn = {
          prompt,
          response,
          timestamp: new Date(),
        };
        this.sessionStorage.addTurn(activeSessionId, turn);
      }

      // Prepare metadata for dual approach:
      // - content[0]._meta: For Claude Code compatibility (avoids structuredContent bug)
      // - structuredContent: For other MCP clients that properly support it
      const metadata: Record<string, unknown> = {
        ...(threadId && { threadId }),
        ...(selectedModel && { model: selectedModel }),
        ...(activeSessionId && { sessionId: activeSessionId }),
        ...(effectiveCallbackUri && { callbackUri: effectiveCallbackUri }),
      };

      return {
        content: [
          {
            type: 'text',
            text: response,
            _meta: metadata,
          },
        ],
        structuredContent:
          isStructuredContentEnabled() && Object.keys(metadata).length > 0
            ? metadata
            : undefined,
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.CODEX, error.message);
      }
      throw new ToolExecutionError(
        TOOLS.CODEX,
        'Failed to execute codex command',
        error
      );
    }
  }

  private buildEnhancedPrompt(
    turns: ConversationTurn[],
    newPrompt: string
  ): string {
    if (turns.length === 0) return newPrompt;

    // Get relevant context from recent turns
    const recentTurns = turns.slice(-2);
    const contextualInfo = recentTurns
      .map((turn) => {
        // Extract key information without conversational format
        if (
          turn.response.includes('function') ||
          turn.response.includes('def ')
        ) {
          return `Previous code context: ${turn.response.slice(0, 200)}...`;
        }
        return `Context: ${turn.prompt} -> ${turn.response.slice(0, 100)}...`;
      })
      .join('\n');

    // Build enhanced prompt that provides context without conversation format
    return `${contextualInfo}\n\nTask: ${newPrompt}`;
  }
}

/**
 * Fires a codex exec WITHOUT awaiting it, tracks the child process in a
 * JobStore, and returns a jobId immediately. This is the closest analogue
 * this transport can offer to Claude Code's Agent-tool background dispatch.
 *
 * Deliberately does not support sessionId/resume: a fire-and-forget job
 * that might still be running when the next call comes in has no sane
 * "resume this" semantics. Poll codexJobStatus/codexJobList instead.
 */
export class CodexStartToolHandler {
  constructor(private jobStore: JobStore) {}

  async execute(
    args: unknown,
    _context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    try {
      const {
        prompt,
        model,
        reasoningEffort,
        sandbox,
        fullAuto,
        workingDirectory,
      }: CodexStartToolArgs = CodexStartToolSchema.parse(args);

      const resolvedWorkDir = workingDirectory
        ? path.resolve(workingDirectory)
        : undefined;
      const selectedModel =
        model || process.env[CODEX_DEFAULT_MODEL_ENV_VAR] || DEFAULT_CODEX_MODEL;
      const enhancedPrompt = withPlatformSafetyNotes(prompt);

      const cmdArgs: string[] = ['exec', '--model', selectedModel];
      if (reasoningEffort) {
        cmdArgs.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
      }
      if (sandbox) {
        cmdArgs.push('--sandbox', sandbox);
      }
      if (fullAuto) {
        cmdArgs.push('--full-auto');
      }
      if (resolvedWorkDir) {
        cmdArgs.push('-C', resolvedWorkDir);
      }
      cmdArgs.push('--skip-git-repo-check', enhancedPrompt);

      const jobId = this.jobStore.create(prompt);

      // Deliberately not awaited: this is the whole point of "start".
      executeCommand('codex', cmdArgs, { cwd: resolvedWorkDir })
        .then((result) => {
          this.jobStore.markCompleted(jobId, result.stdout, result.stderr);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.jobStore.markFailed(jobId, message);
        });

      return {
        content: [
          {
            type: 'text',
            text: `Job started: ${jobId}. Poll with codexJobStatus({ jobId: "${jobId}" }) or codexJobList().`,
            _meta: { jobId, status: 'running' },
          },
        ],
        structuredContent: isStructuredContentEnabled()
          ? { jobId, status: 'running' }
          : undefined,
      };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.CODEX_START, error.message);
      }
      throw new ToolExecutionError(
        TOOLS.CODEX_START,
        'Failed to start codex job',
        error
      );
    }
  }
}

export class JobStatusToolHandler {
  constructor(private jobStore: JobStore) {}

  async execute(
    args: unknown,
    _context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    try {
      const { jobId }: JobStatusToolArgs = JobStatusToolSchema.parse(args);
      const job = this.jobStore.get(jobId);

      if (!job) {
        return {
          content: [
            { type: 'text', text: `No job found with id ${jobId} (expired or never existed).` },
          ],
          isError: true,
        };
      }

      const text =
        job.status === 'running'
          ? `Job ${job.id}: running (started ${job.startedAt.toISOString()})`
          : job.status === 'completed'
            ? `Job ${job.id}: completed (${job.completedAt?.toISOString()})\n\n${job.stdout || job.stderr || 'No output'}`
            : `Job ${job.id}: failed (${job.completedAt?.toISOString()})\n\n${job.error}`;

      return {
        content: [{ type: 'text', text, _meta: { jobId: job.id, status: job.status } }],
        structuredContent: isStructuredContentEnabled()
          ? { jobId: job.id, status: job.status }
          : undefined,
      };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.CODEX_JOB_STATUS, error.message);
      }
      throw new ToolExecutionError(
        TOOLS.CODEX_JOB_STATUS,
        'Failed to check job status',
        error
      );
    }
  }
}

export class JobListToolHandler {
  constructor(private jobStore: JobStore) {}

  async execute(
    args: unknown,
    _context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    try {
      JobListToolSchema.parse(args);
      const jobs = this.jobStore.list().map((job) => ({
        id: job.id,
        status: job.status,
        prompt: job.prompt.slice(0, 100),
        startedAt: job.startedAt.toISOString(),
        completedAt: job.completedAt?.toISOString(),
      }));

      return {
        content: [
          {
            type: 'text',
            text: jobs.length > 0 ? JSON.stringify(jobs, null, 2) : 'No jobs',
          },
        ],
      };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.CODEX_JOB_LIST, error.message);
      }
      throw new ToolExecutionError(
        TOOLS.CODEX_JOB_LIST,
        'Failed to list jobs',
        error
      );
    }
  }
}

export class PingToolHandler {
  async execute(
    args: unknown,
    _context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    try {
      const { message = 'pong' }: PingToolArgs = PingToolSchema.parse(args);

      return {
        content: [
          {
            type: 'text',
            text: message,
          },
        ],
      };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.PING, error.message);
      }
      throw new ToolExecutionError(
        TOOLS.PING,
        'Failed to execute ping command',
        error
      );
    }
  }
}

export class HelpToolHandler {
  async execute(
    args: unknown,
    _context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    try {
      HelpToolSchema.parse(args);

      const result = await executeCommand('codex', ['--help']);

      return {
        content: [
          {
            type: 'text',
            text: result.stdout || 'No help information available',
          },
        ],
      };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.HELP, error.message);
      }
      throw new ToolExecutionError(
        TOOLS.HELP,
        'Failed to execute help command',
        error
      );
    }
  }
}

export class ListSessionsToolHandler {
  constructor(private sessionStorage: SessionStorage) {}

  async execute(
    args: unknown,
    _context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    try {
      ListSessionsToolSchema.parse(args);

      const sessions = this.sessionStorage.listSessions();
      const sessionInfo = sessions.map((session) => ({
        id: session.id,
        createdAt: session.createdAt.toISOString(),
        lastAccessedAt: session.lastAccessedAt.toISOString(),
        turnCount: session.turns.length,
      }));

      return {
        content: [
          {
            type: 'text',
            text:
              sessionInfo.length > 0
                ? JSON.stringify(sessionInfo, null, 2)
                : 'No active sessions',
          },
        ],
      };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.LIST_SESSIONS, error.message);
      }
      throw new ToolExecutionError(
        TOOLS.LIST_SESSIONS,
        'Failed to list sessions',
        error
      );
    }
  }
}

export class ReviewToolHandler {
  constructor(private reviewStore: ReviewStore) {}

  async execute(
    args: unknown,
    context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    let reviewId: string | undefined;
    try {
      const {
        prompt,
        uncommitted,
        base,
        commit,
        title,
        model,
        workingDirectory,
        planId,
        taskId,
        round,
        phase,
      }: ReviewToolArgs = ReviewToolSchema.parse(args);

      if (prompt && uncommitted) {
        throw new ValidationError(
          TOOLS.REVIEW,
          'The review prompt cannot be combined with uncommitted=true. Use a base/commit review or omit the prompt.'
        );
      }

      if (prompt && (base || commit)) {
        throw new ValidationError(
          TOOLS.REVIEW,
          'The review prompt cannot be combined with base or commit — the underlying codex CLI rejects `review --base/--commit <PROMPT>` at the argument-parsing level (verified empirically). Use prompt alone (it can instruct Codex to read a diff file itself via its own file-read capability) or omit the prompt and use base/commit for a plain diff review.'
        );
      }

      // Resolve to absolute path once so -C and spawn cwd agree
      const resolvedWorkDir = workingDirectory
        ? path.resolve(workingDirectory)
        : undefined;

      // Add model parameter via config
      // Reviewer role uses its own default (DEFAULT_REVIEW_MODEL), separate
      // from the implementer role's DEFAULT_CODEX_MODEL, so each can be
      // pinned independently (fork-local change).
      const selectedModel =
        model ||
        process.env[CODEX_REVIEW_MODEL_ENV_VAR] ||
        DEFAULT_REVIEW_MODEL;

      // Build command arguments for codex review
      const cmdArgs: string[] = [];

      // Fork-local Windows workaround: the `codex review` subcommand hardcodes
      // sandbox=read-only and does not honor `-c sandbox_permissions=...`
      // overrides. On Windows, codex's read-only sandbox blocks ALL
      // exec_command calls (verified empirically: even `Get-Content` on a
      // plain text file is rejected with "blocked by policy"), which breaks
      // every prompt-driven review that asks Codex to read a diff/brief file
      // itself. `codex exec -s danger-full-access` does not have this
      // restriction. This fork's usage of `review` is prompt-only (base/
      // commit/uncommitted are validated as mutually exclusive with prompt
      // above), so route the prompt path through `exec` instead of `review`
      // on Windows; the non-prompt (base/commit/uncommitted) path is
      // untouched since it isn't exercised by this fork's callers.
      const usePromptViaExec = process.platform === 'win32' && !!prompt;

      if (usePromptViaExec) {
        cmdArgs.push('exec');
        cmdArgs.push('--model', selectedModel);
        cmdArgs.push('--sandbox', 'danger-full-access');
        if (resolvedWorkDir) {
          cmdArgs.push('-C', resolvedWorkDir);
        }
        cmdArgs.push('--skip-git-repo-check');
        cmdArgs.push(prompt as string);
      } else {
        if (resolvedWorkDir) {
          cmdArgs.push('-C', resolvedWorkDir);
        }

        cmdArgs.push('-c', `model="${selectedModel}"`);

        cmdArgs.push('review');

        // Add review-specific flags
        if (uncommitted) {
          cmdArgs.push('--uncommitted');
        }

        if (base) {
          cmdArgs.push('--base', base);
        }

        if (commit) {
          cmdArgs.push('--commit', commit);
        }

        if (title) {
          cmdArgs.push('--title', title);
        }

        // Add custom review instructions if provided
        if (prompt) {
          cmdArgs.push(prompt);
        }
      }

      // Fork-local: track this call before it runs, so a crash mid-review
      // still leaves a 'failed' record instead of no record at all.
      reviewId = this.reviewStore.create({
        planId,
        taskId,
        round,
        phase,
        model: selectedModel,
      });

      // Send initial progress notification
      await context.sendProgress('Starting code review...', 0);

      const useStreaming = !!context.progressToken;
      // Pass cwd to spawn so the child process starts in the correct directory.
      // This works around openai/codex#9084 where -C is ignored by `review`.
      const cmdOptions = { cwd: resolvedWorkDir };
      const result = useStreaming
        ? await executeCommandStreaming('codex', cmdArgs, {
            ...cmdOptions,
            onProgress: (message) => {
              context.sendProgress(message);
            },
          })
        : await executeCommand('codex', cmdArgs, cmdOptions);

      // Codex CLI outputs to stderr, so check both stdout and stderr
      const response =
        result.stdout || result.stderr || 'No review output from Codex';

      this.reviewStore.markCompleted(reviewId, response);

      // Prepare metadata for dual approach:
      // - content[0]._meta: For Claude Code compatibility (avoids structuredContent bug)
      // - structuredContent: For other MCP clients that properly support it
      const metadata: Record<string, unknown> = {
        reviewId,
        model: selectedModel,
        ...(base && { base }),
        ...(commit && { commit }),
      };

      return {
        content: [
          {
            type: 'text',
            text: response,
            _meta: metadata,
          },
        ],
        structuredContent: isStructuredContentEnabled() ? metadata : undefined,
      };
    } catch (error) {
      if (reviewId) {
        const message = error instanceof Error ? error.message : String(error);
        this.reviewStore.markFailed(reviewId, message);
      } else if (error instanceof ZodError || error instanceof ValidationError) {
        // Fork-local: a rejected call (bad args, or an unsupported
        // prompt+base/commit combo) still gets a record, so
        // reviewList/reviewStatus can audit "an attempt happened and was
        // rejected" — not just successful dispatches.
        const message = error instanceof Error ? error.message : String(error);
        const rejectedId = this.reviewStore.create({});
        this.reviewStore.markFailed(rejectedId, message);
      }
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.REVIEW, error.message);
      }
      if (error instanceof ValidationError) {
        throw error;
      }
      throw new ToolExecutionError(
        TOOLS.REVIEW,
        'Failed to execute code review',
        error
      );
    }
  }
}

/**
 * WebSearchToolHandler - Perform web search via Codex CLI with --search flag
 * Enables Codex's native web_search tool by using --search before exec subcommand
 */
export class WebSearchToolHandler {
  async execute(
    args: unknown,
    context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    try {
      const {
        query,
        numResults = 10,
        searchDepth = 'basic',
      }: WebSearchToolArgs = WebSearchToolSchema.parse(args);

      // Send initial progress notification
      await context.sendProgress(`Searching for: ${query}...`, 0);

      // Build direct search prompt that leverages the enabled web_search tool
      const searchPrompt = `Search for: ${query}. Provide ${numResults} key findings.${searchDepth === 'full' ? ' Include detailed analysis and context.' : ''}`;

      // Build codex command with --search flag before exec subcommand
      const cmdArgs = [
        '--search',
        'exec',
        '--skip-git-repo-check',
        searchPrompt,
      ];

      // Use streaming execution if progress is enabled
      const useStreaming = !!context.progressToken;

      const result = useStreaming
        ? await executeCommandStreaming('codex', cmdArgs, {
            onProgress: (message) => {
              context.sendProgress(message);
            },
          })
        : await executeCommand('codex', cmdArgs);

      // Get response from stdout or stderr (Codex may output to either)
      const response =
        result.stdout || result.stderr || 'No search output from Codex';

      // Prepare metadata
      const metadata: Record<string, unknown> = {
        query,
        numResults,
        searchDepth,
        timestamp: new Date().toISOString(),
      };

      return {
        content: [
          {
            type: 'text',
            text: response,
            _meta: metadata,
          },
        ],
        structuredContent: isStructuredContentEnabled() ? metadata : undefined,
      };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.WEBSEARCH, error.message);
      }
      throw new ToolExecutionError(
        TOOLS.WEBSEARCH,
        'Failed to execute web search',
        error
      );
    }
  }
}

export class ReviewStatusToolHandler {
  constructor(private reviewStore: ReviewStore) {}

  async execute(
    args: unknown,
    _context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    try {
      const { reviewId }: ReviewStatusToolArgs = ReviewStatusToolSchema.parse(args);
      const review = this.reviewStore.get(reviewId);

      if (!review) {
        return {
          content: [
            {
              type: 'text',
              text: `No review found with id ${reviewId} (expired or never existed).`,
            },
          ],
          isError: true,
        };
      }

      const text =
        review.status === 'running'
          ? `Review ${review.id}: running (started ${review.startedAt.toISOString()})`
          : review.status === 'completed'
            ? `Review ${review.id}: completed (${review.completedAt?.toISOString()})\n\n${review.output || 'No output'}`
            : `Review ${review.id}: failed (${review.completedAt?.toISOString()})\n\n${review.error}`;

      return {
        content: [
          {
            type: 'text',
            text,
            _meta: {
              reviewId: review.id,
              status: review.status,
              planId: review.planId,
              taskId: review.taskId,
              phase: review.phase,
            },
          },
        ],
      };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.REVIEW_STATUS, error.message);
      }
      throw new ToolExecutionError(
        TOOLS.REVIEW_STATUS,
        'Failed to check review status',
        error
      );
    }
  }
}

export class ReviewListToolHandler {
  constructor(private reviewStore: ReviewStore) {}

  async execute(
    args: unknown,
    _context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    try {
      const { planId, taskId }: ReviewListToolArgs = ReviewListToolSchema.parse(args);
      const reviews = this.reviewStore.list({ planId, taskId }).map((review) => ({
        id: review.id,
        status: review.status,
        planId: review.planId,
        taskId: review.taskId,
        round: review.round,
        phase: review.phase,
        model: review.model,
        startedAt: review.startedAt.toISOString(),
        completedAt: review.completedAt?.toISOString(),
      }));

      return {
        content: [
          {
            type: 'text',
            text: reviews.length > 0 ? JSON.stringify(reviews, null, 2) : 'No reviews',
          },
        ],
      };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.REVIEW_LIST, error.message);
      }
      throw new ToolExecutionError(
        TOOLS.REVIEW_LIST,
        'Failed to list reviews',
        error
      );
    }
  }
}

// Tool handler registry
const sessionStorage = new InMemorySessionStorage();
const jobStore = new InMemoryJobStore();
const reviewStore = new InMemoryReviewStore();

export const toolHandlers = {
  [TOOLS.CODEX]: new CodexToolHandler(sessionStorage),
  [TOOLS.CODEX_START]: new CodexStartToolHandler(jobStore),
  [TOOLS.CODEX_JOB_STATUS]: new JobStatusToolHandler(jobStore),
  [TOOLS.CODEX_JOB_LIST]: new JobListToolHandler(jobStore),
  [TOOLS.REVIEW]: new ReviewToolHandler(reviewStore),
  [TOOLS.REVIEW_STATUS]: new ReviewStatusToolHandler(reviewStore),
  [TOOLS.REVIEW_LIST]: new ReviewListToolHandler(reviewStore),
  [TOOLS.PING]: new PingToolHandler(),
  [TOOLS.HELP]: new HelpToolHandler(),
  [TOOLS.LIST_SESSIONS]: new ListSessionsToolHandler(sessionStorage),
  [TOOLS.WEBSEARCH]: new WebSearchToolHandler(),
} as const;
