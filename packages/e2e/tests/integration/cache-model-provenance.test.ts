import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { ModelInstance } from '../../src/types.ts';
import type { ExecutorModelCall, StepExecutor } from '../../src/agent/executor.ts';
import { installFakeLoopModel, loopCalls, nodeIdFor } from '../helpers/fake-loop-model.ts';
import { startFixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { contentsUnder, createProject, runExisting } from '../helpers/run-project.ts';
import { onlyActStep, readEntries } from '../helpers/trace-cache.ts';
import { ListReporter } from '../../src/report/list.ts';

const TITLE = 'model provenance';
const SUITE = `import { test, expect } from 'e2e';
test('${TITLE}', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter twice');
  await expect(screen.getByRole('status', 'Counter')).toHaveText('2');
});
`;

/** Supplies real tool-loop responses under a distinct model id without contacting a provider. */
function counterModel(modelId: string): ModelInstance {
  const model = installFakeLoopModel((call) => {
    const screen = call.lastToolResult === '' ? call.prompt : call.lastToolResult;
    if (/"Counter" text="2"/u.test(screen)) {
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'the counter shows 2' } }];
    }
    const target = nodeIdFor(screen, /button "Increment"/u);
    const remaining = /"Counter" text="1"/u.test(screen) ? 1 : 2;
    return Array.from({ length: remaining }, () => ({ toolName: 'tap', input: { target } }));
  });
  return { ...model, modelId };
}

/** Runs the counter flow while reporting the identities supplied by a custom executor. */
function counterExecutor(calls: readonly ExecutorModelCall[]): StepExecutor {
  return {
    name: 'provenance-executor',
    async runStep(context) {
      for (const call of calls) context.budgets.recordModelCall(call);
      for (let index = 0; index < 2; index += 1) {
        const observation = await context.observe();
        await context.actions.tap({ id: nodeIdFor(observation.text, /button "Increment"/u) });
      }
      return { status: 'passed', summary: 'the counter shows 2' };
    },
  };
}

it.each(['model-A', 'model-B'])('identifies the recorded model when replaying with %s without calling it or changing the recording', async (modelId) => {
  const app = await startFixtureApp();
  const project = createProject({ 'tests/provenance.e2e.ts': SUITE });
  try {
    const recorded = await runExisting(project, {
      appUrl: app.url,
      config: { agents: { default: { model: counterModel('model-A') } }, cache: 'read-write', trace: 'on' },
    });
    expect(recorded.exitCode).toBe(0);
    expect(loopCalls.length).toBeGreaterThan(0);
    expect(onlyActStep(recorded, TITLE).model).toMatchObject({ provider: 'fake-loop', model: 'model-A' });
    const [entry] = readEntries(project);
    expect(entry).toBeDefined();
    const before = readFileSync(entry!.file, 'utf8');
    const lines: string[] = [];
    const list = new ListReporter({ write: (line) => lines.push(line) }, { live: false, colors: false });
    const replayed = await runExisting(project, {
      appUrl: app.url,
      config: {
        agents: { default: { model: counterModel(modelId) } }, cache: 'read-only', trace: 'on',
        reporters: [{ name: 'capture', onEvent: (event) => list.handle(event) }],
      },
    });
    expect(replayed.exitCode).toBe(0);
    expect(loopCalls).toHaveLength(0);
    assertValidReport(replayed.report);
    const step = onlyActStep(replayed, TITLE);
    expect(step.metrics?.modelCalls).toBe(0);
    expect(step.model).toBeUndefined();
    expect(lines.filter((line) => line.includes('replayed · recorded with'))).toEqual([
      expect.stringContaining('replayed · recorded with fake-loop/model-A'),
    ]);
    expect(step.cache).toMatchObject({
      mode: 'self-finalized',
      recordedBy: { models: [{ provider: 'fake-loop', model: 'model-A' }], complete: true },
    });
    expect(entry!.entry.payload).toMatchObject({
      recordedBy: { models: [{ provider: 'fake-loop', model: 'model-A' }], complete: true },
    });
    expect(readFileSync(entry!.file, 'utf8')).toBe(before);
  } finally {
    project.cleanup();
    await app.close();
  }
});

it('replays a legacy recording in strict mode without inventing model provenance or updating its bytes', async () => {
  const app = await startFixtureApp();
  const project = createProject({ 'tests/provenance.e2e.ts': SUITE });
  try {
    const recorded = await runExisting(project, { appUrl: app.url, config: { agents: { default: { model: counterModel('model-A') } } } });
    expect(recorded.exitCode).toBe(0);
    const [entry] = readEntries(project);
    const { recordedBy: _recordedBy, ...payload } = entry!.entry.payload;
    writeFileSync(entry!.file, JSON.stringify({ ...entry!.entry, payload }));
    const before = readFileSync(entry!.file, 'utf8');
    const replayed = await runExisting(project, {
      appUrl: app.url,
      config: { agents: { default: { model: counterModel('model-B') } }, cache: { mode: 'read-write', strict: true } },
    });
    expect(replayed.exitCode).toBe(0);
    expect(loopCalls).toHaveLength(0);
    expect(onlyActStep(replayed, TITLE).cache?.mode).toBe('self-finalized');
    expect(onlyActStep(replayed, TITLE).cache?.recordedBy).toBeUndefined();
    expect(readFileSync(entry!.file, 'utf8')).toBe(before);
    assertValidReport(replayed.report);
  } finally {
    project.cleanup();
    await app.close();
  }
});

it.each([false, true])('preserves models from a replayed prefix during a live repair, legacy=%s', async (legacy) => {
  const app = await startFixtureApp();
  const project = createProject({ 'tests/provenance.e2e.ts': SUITE });
  try {
    const recorded = await runExisting(project, { appUrl: app.url, config: { agents: { default: { model: counterModel('model-A') } } } });
    expect(recorded.exitCode).toBe(0);
    const [entry] = readEntries(project);
    const payload = entry!.entry.payload;
    const second = payload.actions[1]!;
    if (second.name !== 'tap') throw new Error('expected the second recorded tap');
    const { recordedBy, ...rest } = payload;
    writeFileSync(entry!.file, JSON.stringify({ ...entry!.entry, payload: {
      ...rest,
      ...(legacy ? {} : { recordedBy }),
      actions: [payload.actions[0], { ...second, target: { ...second.target, name: 'No Such Button' } }],
    } }));
    const repaired = await runExisting(project, { appUrl: app.url, config: { agents: { default: { model: counterModel('model-B') } } } });
    expect(repaired.exitCode).toBe(0);
    expect(onlyActStep(repaired, TITLE).cache).toMatchObject({ mode: 'agent-concluded', replayedActions: 1 });
    expect(loopCalls.length).toBeGreaterThan(0);
    const expected = {
      models: [...(legacy ? [] : [{ provider: 'fake-loop', model: 'model-A' }]), { provider: 'fake-loop', model: 'model-B' }],
      complete: !legacy,
    };
    expect(readEntries(project)[0]!.entry.payload.recordedBy).toEqual(expected);
    const replayed = await runExisting(project, { appUrl: app.url, config: { agents: { default: { model: counterModel('model-C') } } } });
    expect(replayed.exitCode).toBe(0);
    expect(loopCalls).toHaveLength(0);
    expect(onlyActStep(replayed, TITLE).cache?.recordedBy).toEqual(expected);
    expect(onlyActStep(replayed, TITLE).model).toBeUndefined();
    assertValidReport(replayed.report);
  } finally {
    project.cleanup();
    await app.close();
  }
});

it.each([false, true])('records multiple custom-executor model identities with explicit missing metadata, incomplete=%s', async (incomplete) => {
  const app = await startFixtureApp();
  const project = createProject({ 'tests/provenance.e2e.ts': SUITE });
  try {
    const calls = [{ provider: 'custom', modelId: 'first' }, ...(incomplete ? [{}] : [{ provider: 'custom', modelId: 'second' }])];
    const recorded = await runExisting(project, { appUrl: app.url, config: { agents: { default: { executor: counterExecutor(calls) } } } });
    expect(recorded.exitCode).toBe(0);
    const replayed = await runExisting(project, { appUrl: app.url, config: { agents: { default: { model: counterModel('configured-only') } } } });
    expect(replayed.exitCode).toBe(0);
    expect(loopCalls).toHaveLength(0);
    expect(onlyActStep(replayed, TITLE).cache?.recordedBy).toEqual({
      models: [{ provider: 'custom', model: 'first' }, ...(incomplete ? [] : [{ provider: 'custom', model: 'second' }])],
      complete: !incomplete,
    });
    assertValidReport(replayed.report);
  } finally {
    project.cleanup();
    await app.close();
  }
});

it.each([false, true])('redacts model provenance even when a secret resolves in a later step, late=%s', async (late) => {
  const app = await startFixtureApp();
  const secret = 'model-secret-8Vq2Lz5x';
  const suite = SUITE.replace("import { test, expect }", "import { test, expect, secrets }")
    .replace("toHaveText('2');", "toHaveText('2'); await screen.getByLabel('Password').fill(secrets.get('probe'));");
  const project = createProject({ 'tests/provenance.e2e.ts': suite });
  try {
    const config = {
      agents: { default: { executor: counterExecutor([{ provider: `provider-${secret}`, modelId: `model-${secret}` }, { provider: 'public', modelId: 'public' }]) } },
      secrets: { probe: late ? () => secret : secret },
      trace: 'on' as const,
    };
    const recorded = await runExisting(project, { appUrl: app.url, config });
    expect(recorded.exitCode).toBe(0);
    for (const [file, content] of contentsUnder(path.join(project.dir, '.e2e'))) expect(content, file).not.toContain(secret);
    expect(readEntries(project)[0]!.entry.payload.recordedBy).toEqual({
      models: [{ provider: 'provider-<secret:probe>', model: 'model-<secret:probe>' }, { provider: 'public', model: 'public' }], complete: true,
    });
    assertValidReport(recorded.report);
  } finally {
    project.cleanup();
    await app.close();
  }
});

it('redacts a replay report when a later step registers an identity that was public in the recording', async () => {
  const app = await startFixtureApp();
  const project = createProject({ 'tests/provenance.e2e.ts': SUITE });
  const secret = 'previously-public-model-7Qx4';
  try {
    const recorded = await runExisting(project, { appUrl: app.url, config: { agents: { default: { model: counterModel(secret) } } } });
    expect(recorded.exitCode).toBe(0);
    const suite = SUITE.replace("import { test, expect }", "import { test, expect, secrets }")
      .replace("toHaveText('2');", "toHaveText('2'); await screen.getByLabel('Password').fill(secrets.get('probe'));");
    writeFileSync(path.join(project.dir, 'tests/provenance.e2e.ts'), suite);
    const lines: string[] = [];
    const list = new ListReporter({ write: (line) => lines.push(line) }, { live: false, colors: false });
    const replayed = await runExisting(project, {
      appUrl: app.url,
      config: {
        agents: { default: { model: counterModel('model-B') } }, secrets: { probe: () => secret }, trace: 'on',
        reporters: [{ name: 'capture', onEvent: (event) => list.handle(event) }],
      },
    });
    expect(replayed.exitCode).toBe(0);
    expect(loopCalls).toHaveLength(0);
    expect(onlyActStep(replayed, TITLE).cache?.recordedBy?.models[0]!.model).toBe('<secret:probe>');
    expect(JSON.stringify(replayed.report)).not.toContain(secret);
    expect(readFileSync(replayed.reportPath!, 'utf8')).not.toContain(secret);
    expect(lines.join('\n')).not.toContain(secret);
    expect(lines.join('\n')).toContain('replayed · recorded with fake-loop/<secret:probe>');
    assertValidReport(replayed.report);
  } finally {
    project.cleanup();
    await app.close();
  }
});

it.each([false, true])('redacts provenance when a later serial member resolves a secret, replay=%s', async (replay) => {
  const app = await startFixtureApp();
  const secret = 'serial-model-secret-9Rk3';
  const suite = `import { test, expect, secrets } from 'e2e';
test.describe('shared', { serial: true }, () => {
  test('records flow', async ({ app, agent, screen }) => {
    await app.open();
    await agent.act('increment the counter twice');
    await expect(screen.getByRole('status', 'Counter')).toHaveText('2');
  });
  test('resolves secret', async ({ screen }) => {
    await screen.getByLabel('Password').fill(secrets.get('probe'));
  });
});`;
  const file = 'tests/provenance.e2e.ts';
  const project = createProject({ [file]: suite });
  try {
    let before: string | undefined;
    if (replay) {
      writeFileSync(path.join(project.dir, file), suite.replace("await screen.getByLabel('Password').fill(secrets.get('probe'));", ''));
      const recorded = await runExisting(project, { appUrl: app.url, config: { agents: { default: { model: counterModel(secret) } } } });
      expect(recorded.exitCode).toBe(0);
      before = readFileSync(readEntries(project)[0]!.file, 'utf8');
      writeFileSync(path.join(project.dir, file), suite);
    }
    const lines: string[] = [];
    const list = new ListReporter({ write: (line) => lines.push(line) }, { live: false, colors: false });
    const outcome = await runExisting(project, {
      appUrl: app.url,
      config: {
        agents: { default: replay ? { model: counterModel('model-B') } : {
          executor: counterExecutor([{ provider: 'custom', modelId: secret }, { provider: 'custom', modelId: 'public' }]),
        } },
        secrets: { probe: () => secret }, trace: 'on',
        reporters: [{ name: 'capture', onEvent: (event) => list.handle(event) }],
      },
    });
    expect(outcome.exitCode).toBe(0);
    assertValidReport(outcome.report);
    expect(JSON.stringify(outcome.report)).not.toContain(secret);
    expect(readFileSync(outcome.reportPath!, 'utf8')).not.toContain(secret);
    expect(lines.join('\n')).not.toContain(secret);
    if (replay) {
      expect(loopCalls).toHaveLength(0);
      expect(lines.join('\n')).toContain('replayed · recorded with fake-loop/<secret:probe>');
      expect(readFileSync(readEntries(project)[0]!.file, 'utf8')).toBe(before);
    } else {
      for (const [name, content] of contentsUnder(path.join(project.dir, '.e2e'))) expect(content, name).not.toContain(secret);
      expect(readEntries(project)[0]!.entry.payload.recordedBy?.models[0]!.model).toBe('<secret:probe>');
    }
  } finally {
    project.cleanup();
    await app.close();
  }
});
