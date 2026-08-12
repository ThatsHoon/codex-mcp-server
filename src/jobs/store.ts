import { randomUUID } from 'crypto';

export type JobStatus = 'running' | 'completed' | 'failed';

export interface JobRecord {
  id: string;
  status: JobStatus;
  prompt: string;
  startedAt: Date;
  completedAt?: Date;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface JobStore {
  create(prompt: string): string;
  markCompleted(jobId: string, stdout: string, stderr: string): void;
  markFailed(jobId: string, error: string): void;
  get(jobId: string): JobRecord | undefined;
  list(): JobRecord[];
}

/**
 * In-memory background-job tracker, parallel to InMemorySessionStorage.
 * A "job" is a codex invocation that was fired without waiting for it to
 * finish (see CodexToolHandler.executeAsync). This gives the MCP client a
 * poll-based equivalent of Claude Code's Agent-tool background dispatch:
 * there is no way for this server to push an unsolicited completion
 * notification the client's harness will surface (MCP notifications require
 * an open request context the client recognizes; a fire-and-forget job has
 * none), so the client must poll `codexJobStatus`/`codexJobList` instead of
 * expecting an automatic alert.
 */
export class InMemoryJobStore implements JobStore {
  private jobs = new Map<string, JobRecord>();
  private readonly maxJobs = 200;
  private readonly jobTtl = 24 * 60 * 60 * 1000; // 24 hours

  create(prompt: string): string {
    this.cleanupExpired();
    const id = randomUUID();
    this.jobs.set(id, {
      id,
      status: 'running',
      prompt,
      startedAt: new Date(),
    });
    this.enforceMax();
    return id;
  }

  markCompleted(jobId: string, stdout: string, stderr: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = 'completed';
    job.stdout = stdout;
    job.stderr = stderr;
    job.completedAt = new Date();
  }

  markFailed(jobId: string, error: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = 'failed';
    job.error = error;
    job.completedAt = new Date();
  }

  get(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  list(): JobRecord[] {
    this.cleanupExpired();
    return Array.from(this.jobs.values()).sort(
      (a, b) => b.startedAt.getTime() - a.startedAt.getTime()
    );
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      const anchor = job.completedAt ?? job.startedAt;
      if (now - anchor.getTime() > this.jobTtl) {
        this.jobs.delete(id);
      }
    }
  }

  private enforceMax(): void {
    if (this.jobs.size <= this.maxJobs) return;
    const sorted = Array.from(this.jobs.values()).sort(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime()
    );
    for (const job of sorted.slice(0, this.jobs.size - this.maxJobs)) {
      this.jobs.delete(job.id);
    }
  }
}
