import type { Report } from '../types.ts';
import type { RunExitCode, RunStatus } from './events.ts';
import { withProcessOutput } from './process-output.ts';
import { reserveSuiteRun } from './public-ownership.ts';
import { processSecrets } from './secrecy.ts';
import { run as execute, type ListOptions, type RunOptions as InternalRunOptions } from './runner.ts';

/** Options for executing a suite through the public runner API. */
export type SuiteRunOptions = ListOptions & Pick<InternalRunOptions,
  | 'headed' | 'retries' | 'workers' | 'maxFailures' | 'maxDuration' | 'repeatEach'
  | 'reporters' | 'noCache' | 'cacheDir' | 'strictCache' | 'updateSnapshots' | 'agent'
  | 'debug' | 'aiTrace' | 'trace' | 'video' | 'freshGraph' | 'quiet'
  | 'interruptSignal' | 'forceSignal' | 'onEvent'
>;

/** The completed run's report and output paths, without live engine or configuration handles. */
export interface RunResult {
  readonly exitCode: RunExitCode;
  readonly status: RunStatus;
  readonly report: Report;
  readonly reportPath: string | undefined;
  readonly aiTracePath: string | undefined;
}

/** Executes a suite without exiting the caller; await its cleanup before starting another run. */
export async function runSuite(options: SuiteRunOptions = {}): Promise<RunResult> {
  const release = reserveSuiteRun();
  try {
    return await withProcessOutput(processSecrets, async (output) => {
      const { config, targets, ...rest } = options;
      const { exitCode, status, report, reportPath, aiTracePath } = await execute({
        ...rest,
        quiet: options.quiet ?? true,
        processOutput: output,
        ...(typeof config === 'string' ? { configPath: config } : {}),
        ...(config !== undefined && typeof config !== 'string' ? { rawConfig: config } : {}),
        ...(targets !== undefined ? { targetIds: targets } : {}),
      });
      return { exitCode, status, report, reportPath, aiTracePath };
    });
  } finally {
    release();
  }
}
