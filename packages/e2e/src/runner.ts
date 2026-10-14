/** Public runner APIs execute suites, select tests, and host sessions separately from the test SDK. */
export { ConfigurationError, isE2EError, type SerializedError } from './internal/errors.ts';
export { list, type ListOptions, type ListResult, type ListedPair } from './run/runner.ts';
export { runSuite as run, type SuiteRunOptions as RunOptions, type RunResult } from './run/public-run.ts';
export type { RunEventSink } from './run/events.ts';
export { openHost, type E2EHost, type E2ESession, type OpenHostOptions, type OpenSessionOptions } from './run/open-session.ts';
export type { StepProgress, StepRecord } from './run/steps.ts';
