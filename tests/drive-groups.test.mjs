import test from 'node:test';
import assert from 'node:assert/strict';
import { DriveGroups, DRIVE_WINDOW, driveUploadLimit } from '../server/drive-groups.mjs';
import { Operations } from '../server/operations.mjs';
import { account, finishSchedule, usage } from '../server/scheduling.mjs';
import { MediaRunner } from '../server/media-runner.mjs';

async function fixture() {
  let now = Date.parse('2026-10-10T12:00:00Z');
  const state = { jobs: [], cloudRemotes: {}, pending: {}, health: {}, schedules: [] };
  const groups = new DriveGroups({
    state,
    save: async () => {},
    now: () => now,
    inspectMember: async (remote) => ({
      identity: remote === 'duplicate' ? 'a' : remote,
      email: `${remote}@example.invalid`,
      teamDrive: remote === 'other' ? 'other-drive' : 'team',
      rootId: 'team',
    }),
  });
  await groups.write({
    name: 'team-group',
    members: [
      { remote: 'a', budgetBytes: 100 },
      { remote: 'b', budgetBytes: 200 },
    ],
  });
  const ops = new Operations({
    state,
    driveGroups: groups,
    save: async () => {},
    now: () => now,
    notify: async () => {},
  });
  return {
    state,
    groups,
    ops,
    advance: (value) => {
      now += value;
    },
    now: () => now,
  };
}
const job = (extra = {}) => ({
  id: 'job',
  status: 'queued',
  source: { remote: 'source', path: '' },
  destination: { remote: 'team-group', path: 'movies' },
  mode: 'copy',
  ...extra,
});

test('Google group 拒绝同一账号的多个连接和不同团队盘，不提交失败配置', async () => {
  const { groups, state } = await fixture();
  await assert.rejects(
    () =>
      groups.write({
        name: 'bad',
        members: [
          { remote: 'a', budgetBytes: 10 },
          { remote: 'duplicate', budgetBytes: 10 },
        ],
      }),
    /同一个 Google/,
  );
  await assert.rejects(
    () =>
      groups.write({
        name: 'bad',
        members: [
          { remote: 'a', budgetBytes: 10 },
          { remote: 'other', budgetBytes: 10 },
        ],
      }),
    /同一个团队盘/,
  );
  await assert.rejects(
    () => groups.write({ name: 'bad', members: [{ remote: 'a', budgetBytes: 750_000_000_001 }] }),
    /750 GB/,
  );
  assert.equal(state.driveGroups.length, 1);
});

test('额度用完依次换账号，累计字节不重复，全部耗尽等待，午夜不重置，24小时后恢复', async () => {
  const { groups, ops, state, advance } = await fixture();
  const transfer = job();
  state.jobs.push(transfer);
  assert.equal(ops.gate(transfer), null);
  assert.equal(transfer.targetRemote, 'a');
  transfer.limits = ops.limits(transfer);
  assert.equal(transfer.limits.bytes, 100);
  ops.account(transfer, { bytes: 100 });
  ops.account(transfer, { bytes: 100 });
  await ops.finished(transfer, null, { success: false, error: 'max transfer limit reached' });
  assert.equal(transfer.status, 'queued');
  assert.equal(groups.remaining('a'), 0);
  assert.equal(ops.gate(transfer), null);
  assert.equal(transfer.targetRemote, 'b');
  transfer.limits = ops.limits(transfer);
  ops.account(transfer, { bytes: 200 });
  await ops.finished(transfer, null, { success: false, error: 'max transfer limit reached' });
  assert.equal(ops.gate(transfer).status, 'waiting_quota');
  assert.equal(transfer.transferredBytes, 300);
  advance(13 * 3600000);
  assert.equal(groups.remaining('a'), 0);
  advance(11 * 3600000 + 1);
  assert.equal(ops.gate(transfer), null);
  assert.equal(transfer.targetRemote, 'a');
  assert.equal(groups.remaining('a'), 100);
});

test('普通成员上传与多个 group 共用真实账号额度，重启保留用量；下载和预演不消耗上传额度', async () => {
  const { groups, ops, state } = await fixture();
  await groups.write({ name: 'second-group', members: [{ remote: 'a', budgetBytes: 50 }] });
  const ordinary = job({ destination: { remote: 'a', path: '' } });
  assert.equal(ops.gate(ordinary), null);
  ordinary.limits = ops.limits(ordinary);
  assert.equal(ordinary.limits.bytes, 50);
  ops.account(ordinary, { bytes: 25 });
  const restored = new DriveGroups({
    state: structuredClone(state),
    save: async () => {},
    now: groups.now,
  });
  assert.equal(restored.remaining('a'), 25);
  ops.account(job({ dryRun: true, driveIdentity: 'a' }), { bytes: 10 });
  ops.account(job({ source: { remote: 'a' }, destination: { remote: 'local' } }), { bytes: 10 });
  assert.equal(groups.remaining('a'), 25);
});

test('group 和成员的同一目标互斥，其他 group 中同一账号也不能并发预留额度', async () => {
  const { groups, ops, state } = await fixture();
  const active = job({ id: 'active', status: 'running', targetRemote: 'a' });
  state.jobs.push(active);
  assert.equal(ops.gate(job({ destination: { remote: 'b', path: 'other' } })).status, 'queued');
  assert.equal(groups.targetKey('b'), groups.targetKey('team-group'));
});

test('明确上传额度错误冷却账号；普通403、API限流和团队盘存储容量错误不会切换', async () => {
  assert.equal(
    driveUploadLimit('googleapi: Error 403: User rate limit exceeded., userRateLimitExceeded'),
    true,
  );
  for (const message of [
    '403 Forbidden',
    '403 insufficientPermissions',
    '403 userRateLimitExceeded',
    '429 rateLimitExceeded',
    '403 dailyLimitExceeded',
    'storageQuotaExceeded',
    'teamDriveFileLimitExceeded',
  ])
    assert.equal(driveUploadLimit(message), false, message);
  const { groups, ops } = await fixture();
  const transfer = job();
  ops.gate(transfer);
  transfer.limits = ops.limits(transfer);
  await ops.finished(transfer, null, { success: false, error: 'uploadLimitExceeded' });
  assert.equal(transfer.status, 'queued');
  assert.equal(groups.remaining('a'), 0);
  assert.equal(ops.gate(transfer), null);
  assert.equal(transfer.targetRemote, 'b');
});

test('计划账号额度截止保留计划锁并切换，计划自己的总预算截止停止', async () => {
  const { groups, ops, state, now } = await fixture();
  const schedule = {
    id: 'plan',
    enabled: true,
    timezone: 'UTC',
    dailyBytes: 250,
    dailySeconds: 0,
    usage: {},
    runningJobId: 'job',
  };
  state.schedules.push(schedule);
  const transfer = job({ scheduleId: 'plan', quotaDate: '2026-10-10' });
  ops.gate(transfer);
  transfer.limits = ops.limits(transfer);
  account(schedule, transfer, { bytes: 100 }, { finished: false }, now());
  ops.account(transfer, { bytes: 100 });
  const status = {
    success: false,
    error: 'max transfer limit reached',
    endTime: new Date(now()).toISOString(),
  };
  finishSchedule(schedule, transfer, status);
  await ops.finished(transfer, schedule, status);
  assert.equal(transfer.status, 'queued');
  assert.equal(schedule.runningJobId, transfer.id);
  assert.equal(usage(schedule, transfer.quotaDate).outcome, 'running');
  ops.gate(transfer);
  transfer.limits = ops.limits(transfer, schedule);
  transfer.accountedBytes = 0;
  transfer.accountedSeconds = 0;
  assert.equal(transfer.targetRemote, 'b');
  assert.equal(transfer.limits.bytes, 150);
  account(schedule, transfer, { bytes: 150 }, { finished: false }, now());
  ops.account(transfer, { bytes: 150 });
  finishSchedule(schedule, transfer, status);
  await ops.finished(transfer, schedule, status);
  assert.equal(transfer.status, 'limited');
  assert.equal(schedule.runningJobId, null);
  assert.equal(groups.remaining('b'), 50);
});

test('影视复制、文件完成检查和校验均使用本次选择的 group 成员', async () => {
  const { groups } = await fixture();
  const used = [];
  const transfer = job({
    targetRemote: 'b',
    group: 'stats',
    jobId: null,
    media: { enabled: true },
    mediaIndex: 0,
    limits: { bytes: 200, cutoffMode: 'hard' },
    startedAt: new Date().toISOString(),
    files: [
      {
        source: { remote: 'source' },
        sourceFile: 'a.mkv',
        targetFile: 'a.mkv',
        path: 'a.mkv',
        size: 10,
        hashes: {},
        status: 'pending',
      },
    ],
  });
  const runner = new MediaRunner({
    settings: () => ({}),
    resolveFs: async (endpoint, task) => {
      const resolved = groups.endpoint(endpoint, task);
      used.push(resolved.remote);
      return { fs: `${resolved.remote}:` };
    },
    engine: {
      call: async (route) =>
        route === 'core/stats' ? { bytes: 0 } : route === 'operations/stat' ? {} : { jobid: 1 },
    },
  });
  await runner.poll(transfer);
  assert.equal(transfer.jobId, 1);
  assert.equal(used.filter((remote) => remote === 'a').length, 0);
  assert.equal(used.filter((remote) => remote === 'b').length, 2);
});

test('Google 身份检查强制刷新后读取权限，令牌不会返回 view', async () => {
  const calls = [];
  const config = {
    type: 'drive',
    team_drive: 'team',
    token: JSON.stringify({ access_token: 'synthetic-secret' }),
  };
  const groups = new DriveGroups({
    state: { health: {}, pending: {} },
    save: async () => {},
    engine: {
      call: async (route) => {
        calls.push(route);
        return route === 'config/dump' ? { a: config } : {};
      },
    },
    fetcher: async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer synthetic-secret');
      return Response.json(
        String(url).includes('/about?')
          ? { user: { permissionId: 'identity', emailAddress: 'a@example.invalid' } }
          : { id: 'team', driveId: 'team', capabilities: { canAddChildren: true } },
      );
    },
  });
  await groups.write({ name: 'team-group', members: [{ remote: 'a', budgetBytes: 100 }] });
  assert.deepEqual(calls, ['config/dump', 'operations/list', 'config/dump']);
  assert.equal(
    JSON.stringify(groups.remoteView(groups.record('team-group'))).includes('synthetic-secret'),
    false,
  );
});

test('超过所有成员预算的大文件立即报告错误，避免反复切换和24小时重传', async () => {
  const { groups, ops } = await fixture();
  const transfer = job();
  ops.gate(transfer);
  transfer.limits = ops.limits(transfer);
  assert.equal(groups.maxFileBudget('team-group'), 200);
  const runner = new MediaRunner({});
  runner.plan = async () => ({ files: [{ size: 201 }] });
  await assert.rejects(() => runner.start(transfer), /所有账号.*预算/);
});
