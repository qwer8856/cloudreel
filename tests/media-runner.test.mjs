import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaRunner } from '../server/media-runner.mjs';
import { Operations } from '../server/operations.mjs';

test('finished media files refresh transferred bytes before final quota accounting', async () => {
  let statsCalls = 0;
  const requests = [];
  const job = {
    id: 'movie-job',
    jobId: 1,
    group: 'studio/movie-job/1',
    source: { remote: 'source', path: '影视' },
    destination: { remote: 'target', path: '媒体库' },
    media: { enabled: true },
    mediaIndex: 0,
    mediaTotalBytes: 100,
    mediaFailure: '',
    limits: { bytes: 0, seconds: 0, cutoffMode: 'soft' },
    files: [
      {
        path: 'Movie.mkv',
        source: { remote: 'source', path: '影视' },
        sourceFile: 'Movie.mkv',
        targetFile: '电影/Movie.mkv',
        size: 100,
        hashes: {},
        status: 'running',
        bytes: 0,
      },
    ],
  };
  const runner = new MediaRunner({
    resolveFs: async (endpoint) => ({ fs: `${endpoint.remote}:${endpoint.path}` }),
    engine: {
      async call(route, input) {
        requests.push(route);
        if (route === 'core/stats') {
          assert.equal(input.group, job.group);
          return { bytes: statsCalls++ === 0 ? 0 : 100 };
        }
        if (route === 'job/status') {
          assert.equal(input.jobid, 1);
          return { finished: true, success: true, endTime: '2026-10-10T00:00:01.000Z' };
        }
        if (route === 'operations/stat') {
          assert.equal(input.fs, 'target:媒体库');
          assert.equal(input.remote, '电影/Movie.mkv');
          return { item: { Size: 100, IsDir: false } };
        }
        throw new Error(`Unexpected endpoint: ${route}`);
      },
    },
  });
  const result = await runner.poll(job);
  assert.equal(result.status.finished, true);
  assert.equal(result.status.success, true);
  assert.equal(result.stats.bytes, 100);
  assert.equal(result.stats.completedBytes, 100);
  assert.equal(result.stats.transfers, 1);
  assert.equal(job.files[0].status, 'completed');
  assert.equal(job.jobId, null);
  assert.equal(statsCalls, 2);
  assert.ok(requests.lastIndexOf('core/stats') > requests.indexOf('job/status'));
});

test('failed media retries refresh source size and hashes while retaining the archived mapping', async () => {
  const original = {
    path: '电影/Movie.2024.mkv',
    source: { remote: 'source115', path: '资源/电影' },
    sourceFile: 'Movie.2024.mkv',
    targetFile: '电影/Movie (2024)/Movie (2024).mkv',
    size: 3,
    hashes: { sha1: 'old-content-hash' },
    status: 'failed',
  };
  const before = structuredClone(original);
  const resolved = [],
    inspected = [];
  const runner = new MediaRunner({
    resolveFs: async (endpoint) => {
      resolved.push(structuredClone(endpoint));
      return { fs: `${endpoint.remote}:${endpoint.path}` };
    },
  });
  runner.stat = async (source, relative, hashes) => {
    inspected.push({ source: structuredClone(source), relative, hashes });
    return { Size: 18, IsDir: false, Hashes: { sha1: 'updated-content-hash' } };
  };
  const plan = await runner.plan({ mediaRetryFiles: [original] });
  assert.equal(plan.totalFiles, 1);
  assert.equal(plan.totalBytes, 18);
  assert.equal(plan.files[0].size, 18);
  assert.deepEqual(plan.files[0].hashes, { sha1: 'updated-content-hash' });
  assert.equal(plan.files[0].path, original.path);
  assert.deepEqual(plan.files[0].source, original.source);
  assert.equal(plan.files[0].sourceFile, original.sourceFile);
  assert.equal(plan.files[0].targetFile, original.targetFile);
  assert.deepEqual(resolved, [original.source]);
  assert.deepEqual(inspected, [
    { source: original.source, relative: original.sourceFile, hashes: true },
  ]);
  assert.deepEqual(original, before);
});

function queuedJob() {
  return {
    id: 'movie',
    jobId: null,
    group: 'studio/movie/1',
    destination: { remote: 'target', path: '影视库' },
    media: { enabled: true },
    mediaIndex: 0,
    mediaTotalBytes: 100,
    mediaFailure: '',
    limits: { bytes: 0, seconds: 0, cutoffMode: 'soft' },
    files: [
      {
        path: 'Movie.mkv',
        source: { remote: 'source', path: '资源' },
        sourceFile: 'Movie.mkv',
        targetFile: '电影/Movie.mkv',
        size: 100,
        hashes: {},
        status: 'pending',
        bytes: 0,
      },
    ],
  };
}

test('零字节等待与无进展可见，恢复数据后清除计时，等待确认时不丢已传字节', async (t) => {
  let now = Date.parse('2026-10-11T01:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const job = queuedJob();
  job.jobId = 7;
  job.files[0].status = 'running';
  let stats = {
    bytes: 0,
    errors: 1,
    lastError: '115 下载地址接口返回 HTTP 503。',
    retryError: true,
  };
  const runner = new MediaRunner({
    engine: {
      call: async (route) =>
        route === 'core/stats' ? stats : { finished: false, startTime: '2026-10-11T01:00:00Z' },
    },
  });
  await runner.poll(job);
  now += 180000;
  const waiting = await runner.poll(job);
  assert.equal(waiting.status.finished, false);
  assert.equal(waiting.stats.lastError, stats.lastError);
  assert.equal(waiting.stats.retryError, true);
  assert.equal(job.files[0].progressPhase, 'waiting');
  assert.equal(job.files[0].idleSeconds, 180);
  assert.equal(job.files[0].error, undefined);

  stats = { bytes: 30, transferring: [{ bytes: 30, speedAvg: 10 }] };
  await runner.poll(job);
  assert.equal(job.files[0].progressPhase, 'transferring');
  assert.equal(job.files[0].idleSeconds, 0);
  assert.equal(job.files[0].speed, 10);
  now += 90000;
  await runner.poll(job);
  assert.equal(job.files[0].idleSeconds, 90);

  // A retry can restart the file at zero; it is still running, not a final failure.
  stats = { bytes: 30, transferring: [{ bytes: 0, speed: 0 }] };
  await runner.poll(job);
  assert.equal(job.files[0].progressPhase, 'waiting');
  assert.equal(job.files[0].idleSeconds, 0);
  stats = { bytes: 130, transferring: [{ bytes: 100 }] };
  await runner.poll(job);
  stats = { bytes: 130 };
  await runner.poll(job);
  assert.equal(job.files[0].progressPhase, 'finishing');
  assert.equal(job.files[0].bytes, 100);
  assert.equal(job.files[0].speed, 0);
});

test('copy前目标认证或网络检查错误结束当前尝试并保留失败文件映射', async () => {
  for (const message of ['401 unauthorized', 'connection timeout']) {
    const job = queuedJob();
    let copies = 0;
    const runner = new MediaRunner({
      resolveFs: async () => ({ fs: 'target:' }),
      engine: {
        async call(route) {
          if (route === 'core/stats') return { bytes: 0 };
          if (route === 'operations/stat') throw new Error(message);
          if (route === 'operations/copyfile') copies++;
          throw new Error(`Unexpected call ${route}`);
        },
      },
    });
    const result = await runner.poll(job);
    assert.equal(result.status.finished, true);
    assert.equal(result.status.success, false);
    assert.equal(result.status.error, message);
    assert.equal(job.files[0].status, 'failed');
    assert.equal(job.files[0].targetFile, '电影/Movie.mkv');
    assert.equal(job.files[0].sourceFile, 'Movie.mkv');
    assert.equal(job.jobId, null);
    assert.equal(copies, 0);
  }
});

test('copy已完成后的目标检查错误仍保留最新传输字节供额度记账', async () => {
  const job = queuedJob();
  job.jobId = 1;
  job.currentFile = job.files[0].path;
  job.files[0].status = 'running';
  let statsCalls = 0;
  const runner = new MediaRunner({
    resolveFs: async () => ({ fs: 'target:' }),
    engine: {
      async call(route) {
        if (route === 'core/stats') return { bytes: statsCalls++ ? 100 : 0 };
        if (route === 'job/status') return { finished: true, success: true };
        if (route === 'operations/stat') throw new Error('403 authorization expired');
        throw new Error(`Unexpected call ${route}`);
      },
    },
  });
  const result = await runner.poll(job);
  assert.equal(result.status.finished, true);
  assert.equal(result.status.success, false);
  assert.match(result.status.error, /^403 authorization /);
  assert.equal(result.stats.bytes, 100);
  assert.equal(statsCalls, 2);
  assert.equal(job.files[0].status, 'failed');
  assert.equal(job.jobId, null);
  assert.equal(job.currentFile, null);
});

test('启动下一文件前目录解析错误归类为失败，活跃RC查询错误继续保留任务', async () => {
  const job = queuedJob();
  const runner = new MediaRunner({
    resolveFs: async () => {
      throw new Error('source 401 unauthorized');
    },
    engine: {
      async call(route) {
        if (route === 'core/stats') return { bytes: 0 };
        if (route === 'job/status') throw new Error('temporary RC connection error');
        throw new Error(`Unexpected call ${route}`);
      },
    },
  });
  runner.stat = async () => null;
  const result = await runner.poll(job);
  assert.equal(result.status.finished, true);
  assert.equal(result.status.error, 'source 401 unauthorized');
  assert.equal(job.files[0].status, 'failed');
  const active = queuedJob();
  active.jobId = 9;
  active.files[0].status = 'running';
  await assert.rejects(runner.poll(active), /temporary RC connection error/);
  assert.equal(active.jobId, 9);
  assert.equal(active.files[0].status, 'running');
});

test('大量已有文件或预演文件分轮处理，继续执行不重复计算已传字节', async () => {
  for (const dryRun of [false, true]) {
    const job = queuedJob();
    job.dryRun = dryRun;
    const original = job.files[0];
    job.files = Array.from({ length: 121 }, (_, index) => ({
      ...original,
      path: `Movie-${index}.mkv`,
      sourceFile: `Movie-${index}.mkv`,
      targetFile: `电影/Movie-${index}.mkv`,
    }));
    job.files[0].status = 'completed';
    job.files[0].bytes = 100;
    job.mediaIndex = 1;
    job.mediaTotalBytes = 12100;
    let checks = 0;
    const runner = new MediaRunner({
      engine: {
        async call(route) {
          assert.equal(route, 'core/stats');
          return { bytes: 100 };
        },
      },
    });
    runner.stat = async () => {
      checks++;
      return dryRun ? null : { Size: 100, IsDir: false };
    };
    const operations = new Operations({ state: { jobs: [], schedules: [], cloudRemotes: {} } });
    const first = await runner.poll(job);
    operations.account(job, first.stats);
    assert.equal(first.status.finished, false);
    assert.equal(job.mediaIndex, 51);
    assert.equal(checks, 50);
    assert.equal(job.jobId, null);
    assert.equal(job.files[51].status, 'pending');
    const second = await runner.poll(job);
    operations.account(job, second.stats);
    assert.equal(second.status.finished, false);
    assert.equal(job.mediaIndex, 101);
    const last = await runner.poll(job);
    operations.account(job, last.stats);
    assert.equal(last.status.finished, true);
    assert.equal(last.status.success, true);
    assert.equal(job.mediaIndex, 121);
    assert.equal(checks, 120);
    assert.equal(
      job.files.filter((file) => file.status === (dryRun ? 'planned' : 'skipped')).length,
      120,
    );
    assert.equal(last.stats.bytes, 100);
    assert.equal(job.transferredBytes, 100);
  }
});

test('已有文件批次之间暂停不会继续检查目标', async () => {
  const job = queuedJob();
  job.files = Array.from({ length: 100 }, (_, index) => ({
    ...job.files[0],
    path: `Movie-${index}.mkv`,
    targetFile: `Movie-${index}.mkv`,
  }));
  const runner = new MediaRunner({ engine: { call: async () => ({ bytes: 0 }) } });
  let checks = 0;
  runner.stat = async () => {
    checks++;
    return { Size: 100 };
  };
  assert.equal((await runner.poll(job)).status.finished, false);
  job.stopping = true;
  const result = await runner.poll(job);
  assert.equal(result.status.finished, true);
  assert.equal(result.status.success, false);
  assert.equal(checks, 50);
  assert.equal(job.mediaIndex, 50);
});
