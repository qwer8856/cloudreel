import test from 'node:test';
import assert from 'node:assert/strict';
import { Operations, transferOptions } from '../server/operations.mjs';
import { due, finishSchedule } from '../server/scheduling.mjs';

const now = Date.parse('2026-10-10T10:00:00+08:00');
const endpoints = {
  source: { remote: 'source', path: '影视' },
  destination: { remote: 'target', path: '库' },
  mode: 'copy',
};
const plan = () => ({
  ...endpoints,
  id: 'plan',
  enabled: true,
  startTime: '01:00',
  timezone: 'Asia/Shanghai',
  dailyBytes: 1000,
  dailySeconds: 0,
  usage: {},
});
function context(state, extra = {}) {
  return {
    state: { cloudRemotes: {}, jobs: [], schedules: [], ...state },
    now: () => now,
    save: async () => {},
    notify: async () => {},
    transferEndpoints: async () => {},
    launch: async (job) => {
      job.status = 'running';
      job.attempts++;
    },
    ...extra,
  };
}

test('恢复队列重建计划锁并停止同一计划重复任务和过期校验', () => {
  const schedule = plan();
  const jobs = ['new', 'original'].map((id) => ({
    ...endpoints,
    id,
    scheduleId: schedule.id,
    status: 'queued',
    verification: { status: 'running' },
  }));
  const ops = new Operations(context({ jobs, schedules: [schedule] }));
  assert.equal(schedule.runningJobId, 'original');
  assert.equal(jobs[0].status, 'stopped');
  assert.equal(jobs[1].status, 'queued');
  assert.equal(jobs[1].verification.status, 'interrupted');
  assert.equal(due(schedule, now), false);
  assert.ok(ops);
});

test('并发入队与重复调度都只能启动一个计划任务', async () => {
  const schedule = plan();
  let launches = 0;
  const ops = new Operations(
    context(
      { schedules: [schedule] },
      {
        launch: async (job) => {
          launches++;
          await Promise.resolve();
          job.status = 'running';
        },
      },
    ),
  );
  const results = await Promise.allSettled([
    ops.enqueue(schedule, schedule),
    ops.enqueue(schedule, schedule),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(ops.state.jobs.length, 1);
  await Promise.all([ops.dispatch(), ops.dispatch()]);
  assert.equal(launches, 1);
});

test('停用计划保持已有队列，明确手动运行仍可启动', async () => {
  const schedule = { ...plan(), enabled: false };
  const ops = new Operations(context({ schedules: [schedule] }));
  const queued = await ops.enqueue(schedule, schedule);
  assert.equal(queued.status, 'queued');
  assert.equal(schedule.runningJobId, queued.id);
  schedule.enabled = true;
  await ops.dispatch();
  assert.equal(queued.status, 'running');
  const manualPlan = { ...plan(), id: 'manual', enabled: false };
  const manual = new Operations(context({ schedules: [manualPlan] }));
  assert.equal((await manual.enqueue(manualPlan, manualPlan, { manual: true })).status, 'running');
});

test('启动前永久错误释放计划锁；网络重试耗尽后终止并移除重试时间', async () => {
  for (const [error, retries] of [
    ['invalid directory', 0],
    ['connection timeout', 1],
  ]) {
    const schedule = plan();
    const job = {
      ...endpoints,
      id: 'job',
      scheduleId: schedule.id,
      status: retries ? 'retry_wait' : 'queued',
      retries,
      retryAt: now - 1,
    };
    const ops = new Operations(
      context(
        { jobs: [job], schedules: [schedule], operations: { maxRetries: 1 } },
        {
          launch: async () => {
            throw new Error(error);
          },
        },
      ),
    );
    await ops.dispatch();
    assert.equal(job.status, 'failed');
    assert.equal(job.retryAt, undefined);
    assert.equal(schedule.runningJobId, null);
    assert.equal(schedule.usage['2026-10-10'].outcome, 'failed');
    await ops.dispatch();
    assert.equal(job.status, 'failed');
  }
});

test('暂时启动错误保留计划锁，避免重试等待时再建任务', async () => {
  const schedule = plan();
  const ops = new Operations(
    context(
      { schedules: [schedule], operations: { maxRetries: 1 } },
      {
        launch: async () => {
          throw new Error('connection timeout');
        },
      },
    ),
  );
  const job = await ops.enqueue(schedule, schedule);
  assert.equal(job.status, 'retry_wait');
  assert.equal(schedule.runningJobId, job.id);
  assert.equal(due(schedule, now), false);
  await assert.rejects(ops.enqueue(schedule, schedule));
});

test('多来源目录规范化并去重父子路径，拒绝危险路径和混合文件勾选', () => {
  assert.deepEqual(
    transferOptions({ sourcePaths: ['/电影/', '电影', '电影/经典', '剧集'] }).sourcePaths,
    ['电影', '剧集'],
  );
  assert.deepEqual(transferOptions({ sourcePaths: ['', '电影'] }).sourcePaths, ['']);
  assert.equal(transferOptions().media.enabled, false);
  assert.throws(() => transferOptions({ sourcePaths: ['../outside'] }));
  assert.throws(() => transferOptions({ sourcePaths: Array(21).fill('目录') }));
  assert.throws(() =>
    transferOptions({ sourcePaths: ['电影'], selections: [{ path: '片.mkv', isDir: false }] }),
  );
  assert.throws(() => transferOptions({ sourcePaths: ['电影', '剧集'], mode: 'sync' }));
});

test('内部失败文件清单复制保存，客户端字段不能直接注入', async () => {
  const list = [{ sourcePath: '电影/a.mkv', targetPath: '库/a.mkv' }];
  const ops = new Operations(context({}, { launch: async () => {} }));
  const job = await ops.enqueue(
    { ...endpoints, mediaRetryFiles: [{ targetPath: 'wrong' }] },
    null,
    { mediaRetryFiles: list },
  );
  list[0].targetPath = 'changed';
  assert.equal(job.mediaRetryFiles[0].targetPath, '库/a.mkv');
  const normal = await ops.enqueue({ ...endpoints, mediaRetryFiles: list });
  assert.equal(normal.mediaRetryFiles, undefined);
});

test('同目标存储的媒体任务目录重叠时互斥，独立目录可并行', () => {
  const active = {
    ...endpoints,
    id: 'active',
    status: 'running',
    source: { remote: 'source-a' },
    destination: { remote: 'google', path: '库/电影' },
    media: { enabled: true },
  };
  const ops = new Operations(context({ jobs: [active] }));
  const candidate = {
    ...endpoints,
    id: 'candidate',
    source: { remote: 'source-b' },
    media: { enabled: true },
  };
  for (const folder of ['', '库', '库/电影', '库/电影/经典']) {
    const gate = ops.gate({ ...candidate, destination: { remote: 'google', path: folder } });
    assert.equal(gate?.status, 'queued');
    assert.match(gate.reason, /目标目录/);
  }
  assert.equal(
    ops.gate({ ...candidate, destination: { remote: 'google', path: '库/电影合集' } }),
    null,
  );
  assert.equal(
    ops.gate({ ...candidate, destination: { remote: 'other-google', path: '库/电影' } }),
    null,
  );
});

test('计划正常关机保持中断结果和累计额度，下次启动允许恢复', async () => {
  const schedule = plan();
  const job = {
    ...endpoints,
    id: 'job',
    scheduleId: schedule.id,
    quotaDate: '2026-10-10',
    status: 'running',
    stopping: true,
    stopReason: 'shutdown',
    limits: {},
  };
  schedule.runningJobId = job.id;
  schedule.usage['2026-10-10'] = { bytes: 200, seconds: 5, outcome: 'running' };
  const ops = new Operations(context({ schedules: [schedule], jobs: [job] }));
  const status = {
    success: false,
    error: 'context canceled',
    endTime: new Date(now).toISOString(),
  };
  finishSchedule(schedule, job, status);
  await ops.finished(job, schedule, status);
  assert.equal(job.status, 'interrupted');
  assert.equal(schedule.runningJobId, null);
  assert.equal(schedule.usage['2026-10-10'].outcome, 'interrupted');
  assert.equal(schedule.usage['2026-10-10'].bytes, 200);
  assert.equal(schedule.usage['2026-10-10'].seconds, 5);
  const restored = JSON.parse(JSON.stringify(ops.state));
  new Operations(context(restored));
  assert.equal(due(restored.schedules[0], now), true);
});

test('重复扫描间隔依据注入时钟，忽略rclone实际机器完成时间', async () => {
  const schedule = { ...plan(), scanIntervalMinutes: 15 };
  const job = {
    ...endpoints,
    id: 'job',
    scheduleId: schedule.id,
    quotaDate: '2026-10-10',
    status: 'running',
  };
  const ops = new Operations(context({ schedules: [schedule], jobs: [job] }));
  await ops.finished(job, schedule, { success: true, endTime: '2026-10-01T00:00:00Z' });
  assert.equal(schedule.nextScanAt, now + 15 * 60000);
  assert.equal(due(schedule, now + 14 * 60000), false);
  assert.equal(due(schedule, now + 15 * 60000), true);
});

test('自身后台校验仍在运行时恢复任务留在队列，校验结束后才开始', async () => {
  const job = { ...endpoints, id: 'self', status: 'queued', attempts: 0 };
  let launches = 0;
  const ops = new Operations(
    context(
      { jobs: [job] },
      {
        launch: async (item) => {
          launches++;
          item.status = 'running';
        },
      },
    ),
  );
  job.verification = { status: 'running' };
  assert.equal(ops.gate(job)?.status, 'queued');
  await ops.dispatch();
  assert.equal(job.status, 'queued');
  assert.equal(launches, 0);
  assert.match(job.waitReason, /完成校验/);
  job.verification.status = 'completed';
  await ops.dispatch();
  assert.equal(job.status, 'running');
  assert.equal(launches, 1);
});
