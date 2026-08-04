import { CodexToolHandler } from '../tools/handlers.js';
import { InMemorySessionStorage } from '../session/storage.js';
import { executeCommand } from '../utils/command.js';

// Mock the command execution
jest.mock('../utils/command.js', () => ({
  executeCommand: jest.fn(),
}));

const mockedExecuteCommand = executeCommand as jest.MockedFunction<
  typeof executeCommand
>;

describe('Windows UTF-8 safety note injection (fork-local)', () => {
  let handler: CodexToolHandler;
  let sessionStorage: InMemorySessionStorage;
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    sessionStorage = new InMemorySessionStorage();
    handler = new CodexToolHandler(sessionStorage);
    mockedExecuteCommand.mockClear();
    mockedExecuteCommand.mockResolvedValue({ stdout: 'ok', stderr: '' });
    delete process.env.CODEX_MCP_DISABLE_WIN_UTF8_NOTE;
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    delete process.env.CODEX_MCP_DISABLE_WIN_UTF8_NOTE;
  });

  test('prepends the safety note on win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    await handler.execute({ prompt: 'Write a Korean label' });

    const call = mockedExecuteCommand.mock.calls[0];
    const sentPrompt = call?.[1]?.[call[1].length - 1] as string;
    expect(sentPrompt.startsWith('[Windows]')).toBe(true);
    expect(sentPrompt.endsWith('Write a Korean label')).toBe(true);
  });

  test('does not prepend the note on non-Windows platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });

    await handler.execute({ prompt: 'Write a Korean label' });

    const call = mockedExecuteCommand.mock.calls[0];
    const sentPrompt = call?.[1]?.[call[1].length - 1] as string;
    expect(sentPrompt).toBe('Write a Korean label');
  });

  test('respects CODEX_MCP_DISABLE_WIN_UTF8_NOTE=1 on win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.CODEX_MCP_DISABLE_WIN_UTF8_NOTE = '1';

    await handler.execute({ prompt: 'Write a Korean label' });

    const call = mockedExecuteCommand.mock.calls[0];
    const sentPrompt = call?.[1]?.[call[1].length - 1] as string;
    expect(sentPrompt).toBe('Write a Korean label');
  });
});
