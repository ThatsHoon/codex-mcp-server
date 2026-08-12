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
}));

import { InMemoryJobStore } from '../jobs/store.js';
import {
  CodexStartToolHandler,
  JobStatusToolHandler,
  JobListToolHandler,
} from '../tools/handlers.js';

describe('background job dispatch (codexStart / codexJobStatus / codexJobList)', () => {
  test('start returns a jobId immediately without waiting for the process to finish', async () => {
    let resolveExec!: (v: { stdout: string; stderr: string }) => void;
    mockExecuteCommand.mockReturnValue(
      new Promise((resolve) => {
        resolveExec = resolve;
      })
    );

    const store = new InMemoryJobStore();
    const start = new CodexStartToolHandler(store);

    const result = await start.execute({ prompt: 'do a slow thing' });
    const jobId = (result.content[0]._meta as { jobId: string }).jobId;

    expect(jobId).toBeTruthy();
    expect(store.get(jobId)?.status).toBe('running');

    // The underlying command hasn't resolved yet -- start() still returned.
    resolveExec({ stdout: 'done', stderr: '' });
    // let the un-awaited .then() in executeAsync flush
    await new Promise((r) => setImmediate(r));

    expect(store.get(jobId)?.status).toBe('completed');
    expect(store.get(jobId)?.stdout).toBe('done');
  });

  test('status reports running then completed, list shows the job', async () => {
    mockExecuteCommand.mockResolvedValue({ stdout: 'ok', stderr: '' });

    const store = new InMemoryJobStore();
    const start = new CodexStartToolHandler(store);
    const status = new JobStatusToolHandler(store);
    const list = new JobListToolHandler(store);

    const startResult = await start.execute({ prompt: 'quick task' });
    const jobId = (startResult.content[0]._meta as { jobId: string }).jobId;

    await new Promise((r) => setImmediate(r));

    const statusResult = await status.execute({ jobId });
    expect((statusResult.content[0]._meta as { status: string }).status).toBe(
      'completed'
    );

    const listResult = await list.execute({});
    const jobs = JSON.parse(listResult.content[0].text as string);
    expect(jobs.some((j: { id: string }) => j.id === jobId)).toBe(true);
  });

  test('status on unknown jobId returns isError, not a thrown exception', async () => {
    const store = new InMemoryJobStore();
    const status = new JobStatusToolHandler(store);

    const result = await status.execute({ jobId: 'does-not-exist' });
    expect(result.isError).toBe(true);
  });
});
