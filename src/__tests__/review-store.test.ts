import { InMemoryReviewStore } from '../tracking/review-store.js';

describe('InMemoryReviewStore', () => {
  test('create returns a reviewId and starts the record as running', () => {
    const store = new InMemoryReviewStore();
    const id = store.create({ planId: 'plan-a', taskId: '3', phase: 'task-review' });

    expect(id).toBeTruthy();
    const record = store.get(id);
    expect(record?.status).toBe('running');
    expect(record?.planId).toBe('plan-a');
    expect(record?.taskId).toBe('3');
    expect(record?.phase).toBe('task-review');
  });

  test('markCompleted transitions to completed and stores output', () => {
    const store = new InMemoryReviewStore();
    const id = store.create({ phase: 'final-review' });

    store.markCompleted(id, 'Spec ✅ - all requirements met.');

    const record = store.get(id);
    expect(record?.status).toBe('completed');
    expect(record?.output).toBe('Spec ✅ - all requirements met.');
    expect(record?.completedAt).toBeInstanceOf(Date);
  });

  test('markFailed transitions to failed and stores the error', () => {
    const store = new InMemoryReviewStore();
    const id = store.create({ phase: 're-review', round: 2 });

    store.markFailed(id, 'codex exec exited 1');

    const record = store.get(id);
    expect(record?.status).toBe('failed');
    expect(record?.error).toBe('codex exec exited 1');
  });

  test('get on unknown reviewId returns undefined', () => {
    const store = new InMemoryReviewStore();
    expect(store.get('does-not-exist')).toBeUndefined();
  });

  test('list returns newest first', () => {
    const store = new InMemoryReviewStore();
    const first = store.create({ planId: 'p', phase: 'task-review' });
    const second = store.create({ planId: 'p', phase: 'task-review' });

    const results = store.list();
    expect(results[0].id).toBe(second);
    expect(results[1].id).toBe(first);
  });

  test('list filters by planId and taskId', () => {
    const store = new InMemoryReviewStore();
    const wanted = store.create({ planId: 'plan-a', taskId: '1', phase: 'task-review' });
    store.create({ planId: 'plan-b', taskId: '1', phase: 'task-review' });
    store.create({ planId: 'plan-a', taskId: '2', phase: 'task-review' });

    const results = store.list({ planId: 'plan-a', taskId: '1' });
    expect(results.map((r) => r.id)).toEqual([wanted]);
  });
});
