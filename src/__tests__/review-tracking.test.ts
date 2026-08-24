jest.mock('chalk', () => ({
  default: {
    blue: (text: string) => text,
    yellow: (text: string) => text,
    green: (text: string) => text,
    red: (text: string) => text,
  },
}));

const mockExecuteCommand = jest.fn();
jest.mock('../utils/command.js', () => ({
  executeCommand: (...args: unknown[]) => mockExecuteCommand(...args),
  executeCommandStreaming: (...args: unknown[]) => mockExecuteCommand(...args),
}));

import { InMemoryReviewStore } from '../tracking/review-store.js';
import {
  ReviewToolHandler,
  ReviewStatusToolHandler,
  ReviewListToolHandler,
} from '../tools/handlers.js';

describe('review tracking (review / reviewStatus / reviewList)', () => {
  test('a completed review is tracked with its planId/taskId/phase and readable via reviewStatus', async () => {
    mockExecuteCommand.mockResolvedValue({ stdout: 'Spec ✅ - clean.', stderr: '' });

    const store = new InMemoryReviewStore();
    const review = new ReviewToolHandler(store);
    const status = new ReviewStatusToolHandler(store);

    const result = await review.execute({
      base: 'main',
      planId: 'my-plan',
      taskId: '3',
      phase: 'task-review',
    });
    const reviewId = (result.content[0]._meta as { reviewId: string }).reviewId;

    expect(reviewId).toBeTruthy();
    expect(store.get(reviewId)?.status).toBe('completed');
    expect(store.get(reviewId)?.planId).toBe('my-plan');
    expect(store.get(reviewId)?.phase).toBe('task-review');

    const statusResult = await status.execute({ reviewId });
    expect((statusResult.content[0]._meta as { status: string }).status).toBe('completed');
    expect(statusResult.content[0].text).toContain('Spec ✅ - clean.');
  });

  test('a failed codex exec marks the review failed, not thrown past the handler', async () => {
    mockExecuteCommand.mockRejectedValue(new Error('codex exec exited 1'));

    const store = new InMemoryReviewStore();
    const review = new ReviewToolHandler(store);

    await expect(review.execute({ base: 'main', phase: 'final-review' })).rejects.toThrow();

    const [record] = store.list();
    expect(record.status).toBe('failed');
    expect(record.error).toContain('codex exec exited 1');
  });

  test('reviewList filters by planId and taskId', async () => {
    mockExecuteCommand.mockResolvedValue({ stdout: 'ok', stderr: '' });

    const store = new InMemoryReviewStore();
    const review = new ReviewToolHandler(store);
    const list = new ReviewListToolHandler(store);

    await review.execute({ base: 'main', planId: 'plan-a', taskId: '1', phase: 'task-review' });
    await review.execute({ base: 'main', planId: 'plan-b', taskId: '1', phase: 'task-review' });

    const listResult = await list.execute({ planId: 'plan-a' });
    const reviews = JSON.parse(listResult.content[0].text as string);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].planId).toBe('plan-a');
  });

  test('reviewStatus on unknown reviewId returns isError, not a thrown exception', async () => {
    const store = new InMemoryReviewStore();
    const status = new ReviewStatusToolHandler(store);

    const result = await status.execute({ reviewId: 'does-not-exist' });
    expect(result.isError).toBe(true);
  });
});
