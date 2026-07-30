import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import type { WriteStream } from 'node:fs';
import type { Logger } from 'pino';
import type { ChildProcessResult } from '../types.js';

interface RunLoggedProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  logStream: WriteStream;
  signal?: AbortSignal;
  logger: Logger;
  onChild?: (child: ChildProcess) => void;
}

export function runLoggedProcess(options: RunLoggedProcessOptions): Promise<ChildProcessResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    let lastLine: string | null = null;
    let lastStderrLine: string | null = null;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;

    const settle = (result: ChildProcessResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (killTimer) {
        clearTimeout(killTimer);
      }
      resolve(result);
    };

    try {
      options.logger.debug?.(
        { event: 'child.started', command: options.command, cwd: options.cwd },
        'child process started'
      );
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      settle({
        code: null,
        signal: null,
        lastLine,
        lastStderrLine,
        error: error instanceof Error ? error : new Error(String(error))
      });
      return;
    }

    options.onChild?.(child);

    if (!child.stdout || !child.stderr) {
      settle({
        code: null,
        signal: null,
        lastLine,
        lastStderrLine,
        error: new Error('child process did not expose stdout/stderr streams')
      });
      return;
    }

    const writeLine = (line: string, streamName: 'stdout' | 'stderr') => {
      lastLine = line;
      if (streamName === 'stderr') {
        lastStderrLine = line;
      }
      options.logStream.write(`${line}\n`);
    };

    const stdout = readline.createInterface({ input: child.stdout });
    const stderr = readline.createInterface({ input: child.stderr });
    stdout.on('line', (line) => writeLine(line, 'stdout'));
    stderr.on('line', (line) => writeLine(line, 'stderr'));

    const terminate = () => {
      if (child.killed) {
        return;
      }
      options.logger.debug?.({ event: 'child.terminate', command: options.command }, 'terminating child process');
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!child.killed) {
          options.logger.debug?.({ event: 'child.kill', command: options.command }, 'killing child process');
          child.kill('SIGKILL');
        }
      }, 1000);
    };

    if (options.signal?.aborted) {
      terminate();
    } else {
      options.signal?.addEventListener('abort', terminate, { once: true });
    }

    child.on('error', (error) => {
      options.logger.debug?.({ event: 'child.spawn_error', error, command: options.command }, 'child process spawn error');
      settle({
        code: null,
        signal: null,
        lastLine,
        lastStderrLine,
        error
      });
    });

    child.on('close', (code, signal) => {
      stdout.close();
      stderr.close();
      options.logger.debug?.(
        { event: 'child.exited', command: options.command, code, signal },
        'child process exited'
      );
      settle({
        code,
        signal,
        lastLine,
        lastStderrLine,
        error: null
      });
    });
  });
}

export function childFailureSummary(tool: string, result: ChildProcessResult): string {
  if (result.error) {
    return truncateOneLine(`${tool} failed to start: ${result.error.message}`);
  }
  if (result.signal) {
    return truncateOneLine(`${tool} exited by signal ${result.signal}: ${result.lastStderrLine ?? result.lastLine ?? 'no output'}`);
  }
  return truncateOneLine(`${tool} exited with code ${result.code ?? 'unknown'}: ${result.lastStderrLine ?? result.lastLine ?? 'no output'}`);
}

export function truncateOneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown error';
}

export function commandLine(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function isEnospc(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOSPC';
}
