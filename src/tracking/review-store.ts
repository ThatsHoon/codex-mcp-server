import { randomUUID } from 'crypto';

export type ReviewStatus = 'running' | 'completed' | 'failed';
export type ReviewPhase = 'task-review' | 're-review' | 'final-review';

export interface ReviewRecord {
  id: string;
  status: ReviewStatus;
  planId?: string;
  taskId?: string;
  round?: number;
  phase?: ReviewPhase;
  model?: string;
  startedAt: Date;
  completedAt?: Date;
  output?: string;
  error?: string;
}

export interface ReviewStoreMeta {
  planId?: string;
  taskId?: string;
  round?: number;
  phase?: ReviewPhase;
  model?: string;
}

export interface ReviewListFilter {
  planId?: string;
  taskId?: string;
}

export interface ReviewStore {
  create(meta: ReviewStoreMeta): string;
  markCompleted(reviewId: string, output: string): void;
  markFailed(reviewId: string, error: string): void;
  get(reviewId: string): ReviewRecord | undefined;
  list(filter?: ReviewListFilter): ReviewRecord[];
}

/**
 * In-memory review tracker, parallel to InMemoryJobStore. A "review" is one
 * `codex review` invocation dispatched via the `review` tool. Unlike jobs,
 * reviews are dispatched synchronously (the caller already blocks on the
 * result — see ReviewToolHandler), so this store's only job is to give
 * callers a queryable record of what was reviewed (plan/task/round/phase
 * tagged) after the fact — via reviewStatus/reviewList — independent of any
 * one caller's own ledger file surviving. It is not a mechanism for making
 * review non-blocking.
 */
export class InMemoryReviewStore implements ReviewStore {
  private reviews = new Map<string, ReviewRecord>();
  private readonly maxReviews = 200;
  private readonly reviewTtl = 24 * 60 * 60 * 1000; // 24 hours

  create(meta: ReviewStoreMeta): string {
    this.cleanupExpired();
    const id = randomUUID();
    this.reviews.set(id, {
      id,
      status: 'running',
      startedAt: new Date(),
      ...meta,
    });
    this.enforceMax();
    return id;
  }

  markCompleted(reviewId: string, output: string): void {
    const review = this.reviews.get(reviewId);
    if (!review) return;
    review.status = 'completed';
    review.output = output;
    review.completedAt = new Date();
  }

  markFailed(reviewId: string, error: string): void {
    const review = this.reviews.get(reviewId);
    if (!review) return;
    review.status = 'failed';
    review.error = error;
    review.completedAt = new Date();
  }

  get(reviewId: string): ReviewRecord | undefined {
    return this.reviews.get(reviewId);
  }

  list(filter?: ReviewListFilter): ReviewRecord[] {
    this.cleanupExpired();
    // Zip with insertion order index before filtering. When multiple records share
    // the same startedAt timestamp (common under coarse OS clock resolution),
    // tie-break by insertion order (higher index = newer) to ensure newest-first.
    let results = Array.from(this.reviews.values()).map((r, i) => ({ r, i }));

    if (filter?.planId) {
      results = results.filter((item) => item.r.planId === filter.planId);
    }
    if (filter?.taskId) {
      results = results.filter((item) => item.r.taskId === filter.taskId);
    }

    return results
      .sort((a, b) => {
        const timeDiff = b.r.startedAt.getTime() - a.r.startedAt.getTime();
        return timeDiff !== 0 ? timeDiff : b.i - a.i;
      })
      .map((item) => item.r);
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, review] of this.reviews) {
      const anchor = review.completedAt ?? review.startedAt;
      if (now - anchor.getTime() > this.reviewTtl) {
        this.reviews.delete(id);
      }
    }
  }

  private enforceMax(): void {
    if (this.reviews.size <= this.maxReviews) return;
    const sorted = Array.from(this.reviews.values()).sort(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime()
    );
    for (const review of sorted.slice(0, this.reviews.size - this.maxReviews)) {
      this.reviews.delete(review.id);
    }
  }
}
