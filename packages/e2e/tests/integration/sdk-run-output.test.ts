import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProject, contentsUnder, type FixtureProject } from '../helpers/run-project.ts';

const execute = promisify(execFile);
const projects: FixtureProject[] = [];
const SECRET = 'sdk-sentinel-4242-private-value';

afterEach(() => { for (const fixture of projects.splice(0)) fixture.cleanup(); });

/** Captures the real process streams around an embedded suite, independently of Vitest's output. */
async function inHost(files: Record<string, string>) {
  const fixture = createProject(files);
  projects.push(fixture);
  const result = await execute(process.execPath, ['host.mjs'], {
    cwd: fixture.dir,
    env: { ...process.env, E2E_TELEMETRY_DISABLED: '1', NO_COLOR: '1' },
    timeout: 30_000,
  });
  expect(result.stdout).not.toContain(SECRET);
  expect(result.stderr).not.toContain(SECRET);
  for (const [file, content] of contentsUnder(path.join(fixture.dir, '.e2e'))) expect(content, file).not.toContain(SECRET);
  return result;
}

const config = `import { defineEngine } from 'e2e/engine';
const engine = defineEngine({ name: 'noop', version: '1', spiVersion: 1 });
const config = { targets: [{ name: 'noop', platform: 'test', engine }], secrets: { sentinel: '${SECRET}' } };`;

describe('public run output', () => {
  it('redacts runtime-config collection, body, and split-byte writes, then resumes caller output', async () => {
    const result = await inHost({
      'host.mjs': `import { run } from 'e2e/runner';
import assert from 'node:assert/strict';
${config}
const result = await run({ config });
assert.equal(result.exitCode, 0);
await new Promise((resolve) => process.stdout.write(Buffer.from('HOST_RESTORED\\n').toString('hex'), 'hex', resolve));`,
      'tests/output.e2e.ts': `import { test } from 'e2e';
console.log('collected: ${SECRET}');
test('logs', async () => {
  console.error('body: ${SECRET}');
  process.stdout.write('${SECRET.slice(0, 11)}');
  process.stdout.write('${SECRET.slice(11)}\\n');
  process.stderr.write(Buffer.from('${SECRET}\\n').toString('base64'), 'base64');
});`,
    });
    expect(result.stdout).toContain('HOST_RESTORED');
    expect(result.stdout + result.stderr).toContain('secret:sentinel');
  });

  it('holds a file config output until its secrets are known', async () => {
    const result = await inHost({
      'host.mjs': `import { run } from 'e2e/runner';
import assert from 'node:assert/strict';
const result = await run({ config: 'e2e.config.ts' });
assert.equal(result.exitCode, 0);`,
      'e2e.config.ts': `${config}
console.log('${SECRET}');
export default config;`,
      'tests/one.e2e.ts': `import { test } from 'e2e'; test('one', async () => {});`,
    });
    expect(result.stdout).toContain('secret:sentinel');
  });

  it('withholds failed config output and resumes caller output before the next run', async () => {
    const result = await inHost({
      'host.mjs': `import { run } from 'e2e/runner';
import assert from 'node:assert/strict';
${config}
const failed = await run({ config: 'bad.config.ts' });
assert.equal(failed.exitCode, 2);
const next = await run({ config });
assert.equal(next.exitCode, 0);
console.log('NEXT_RUN_PASSED');`,
      'bad.config.ts': `console.log('${SECRET}'); throw new Error('bad config');`,
      'tests/one.e2e.ts': `import { test } from 'e2e'; test('one', async () => {});`,
    });
    expect(result.stderr).toContain('withheld');
    expect(result.stdout).toContain('NEXT_RUN_PASSED');
  });

  it('keeps a timed-out body redacted after its suite returns and a later suite runs', async () => {
    const result = await inHost({
      'host.mjs': `import { run } from 'e2e/runner';
import assert from 'node:assert/strict';
${config}
const first = await run({ config, files: ['tests/late.e2e.ts'] });
assert.equal(first.exitCode, 1);
console.log('SUITE_RETURNED');
const second = await run({ config: { ...config, secrets: { sentinel: 'next-run-private-value' } }, files: ['tests/next.e2e.ts'] });
assert.equal(second.exitCode, 0);
await new Promise((resolve) => setTimeout(resolve, 700));
console.log('CALLER_OUTPUT_RESUMED');`,
      'tests/late.e2e.ts': `import { test } from 'e2e';
test('late output', { timeout: 30 }, async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log('late: ${SECRET}');
});`,
      'tests/next.e2e.ts': `import { test } from 'e2e'; test('next', async () => {});`,
    });
    expect(result.stdout).toContain('SUITE_RETURNED');
    expect(result.stdout).toContain('late: <secret:sentinel>');
    expect(result.stdout).toContain('CALLER_OUTPUT_RESUMED');
    expect(result.stdout.indexOf('SUITE_RETURNED')).toBeLessThan(result.stdout.indexOf('late:'));
  });
});
