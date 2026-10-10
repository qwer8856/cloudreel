import test from 'node:test';
import assert from 'node:assert/strict';
import {
  account,
  calendar,
  due,
  exhausted,
  finishSchedule,
  scheduleView,
  usage,
  validateSchedule,
} from '../server/scheduling.mjs';

const template = () => ({
  id: 'plan',
  name: '每日备份',
  mode: 'copy',
  enabled: true,
  source: { remote: 'local', path: 'source' },
  destination: { remote: 'local', path: 'target' },
  startTime: '01:00',
  timezone: 'Asia/Shanghai',
  dailyBytes: 1024 ** 3,
  dailySeconds: 3600,
  cutoffMode: 'hard',
  usage: {},
  runningJobId: null,
});
const now = Date.parse('2026-10-06T02:00:00+08:00');

test('计划参数拒绝无效时区、时间、额度、路径和未确认的同步', () => {
  assert.equal(validateSchedule(template()).timezone, 'Asia/Shanghai');
  for (const patch of [
    { timezone: 'invalid/zone' },
    { startTime: '25:00' },
    { dailyBytes: -1 },
    { dailySeconds: 86401 },
    { dailyBytes: 0, dailySeconds: 0 },
    { cutoffMode: 'unknown' },
    { mode: 'sync' },
    { destination: { remote: 'local', path: '../outside' } },
  ])
    assert.throws(() => validateSchedule({ ...template(), ...patch }));
  assert.equal(validateSchedule({ ...template(), mode: 'sync', confirmDelete: true }).mode, 'sync');
});

test('每日日期按所选时区计算，跨日额度独立', () => {
  const midnight = Date.parse('2026-10-06T16:00:00Z');
  assert.equal(calendar(midnight, 'Asia/Shanghai').date, '2026-10-07');
  assert.equal(calendar(midnight, 'UTC').date, '2026-10-06');
  const plan = template();
  usage(plan, '2026-10-06', true).bytes = plan.dailyBytes;
  assert.equal(due(plan, now), false);
  assert.equal(due(plan, now + 86400000), true);
  assert.equal(scheduleView(plan, now + 86400000).today.bytes, 0);
  assert.equal(plan.usage['2026-10-06'].bytes, plan.dailyBytes);
});

test('开始时间、运行锁和当天结果共同防止重复启动', () => {
  const plan = template();
  assert.equal(due(plan, Date.parse('2026-10-06T00:59:00+08:00')), false);
  assert.equal(due(plan, now), true);
  plan.runningJobId = 'active';
  assert.equal(due(plan, now), false);
  plan.runningJobId = null;
  usage(plan, '2026-10-06', true).outcome = 'completed';
  assert.equal(due(plan, now), false);
  plan.usage['2026-10-06'].outcome = 'failed';
  assert.equal(due(plan, now), false);
  plan.usage['2026-10-06'].outcome = 'interrupted';
  assert.equal(due(plan, now), true);
  plan.enabled = false;
  assert.equal(due(plan, now), false);
});

test('夏令时重复小时不会重复执行，跳过的开始时间会补运行', () => {
  const plan = { ...template(), timezone: 'America/New_York', startTime: '01:30' };
  assert.equal(due(plan, Date.parse('2026-11-01T05:30:00Z')), true);
  usage(plan, '2026-11-01', true).outcome = 'completed';
  assert.equal(due(plan, Date.parse('2026-11-01T06:30:00Z')), false);
  plan.startTime = '02:30';
  assert.equal(due(plan, Date.parse('2026-03-08T07:00:00Z')), true);
});

test('轮询重复、停止重试和重启后保持累计用量', () => {
  let plan = template();
  const job = { quotaDate: '2026-10-06', createdAt: new Date(now).toISOString() };
  account(plan, job, { bytes: 100 }, {}, now + 2000);
  account(plan, job, { bytes: 100 }, {}, now + 2000);
  assert.equal(plan.usage['2026-10-06'].bytes, 100);
  assert.equal(plan.usage['2026-10-06'].seconds, 2);
  account(
    plan,
    job,
    { bytes: 150 },
    { finished: true, endTime: new Date(now + 3500).toISOString() },
    now + 5000,
  );
  assert.equal(plan.usage['2026-10-06'].seconds, 3.5);
  plan = JSON.parse(JSON.stringify(plan));
  const retry = { quotaDate: '2026-10-06', createdAt: new Date(now + 10000).toISOString() };
  account(plan, retry, { bytes: 80 }, {}, now + 12000);
  assert.equal(plan.usage['2026-10-06'].bytes, 230);
  assert.equal(plan.usage['2026-10-06'].seconds, 5.5);
});

test('正常额度截止归类为等待次日，手动暂停和失败保留各自状态', () => {
  for (const [error, expected] of [
    ['max transfer limit reached as set by --max-transfer', 'bytes_limit'],
    ['max duration reached as set by --max-duration', 'time_limit'],
    ['permission denied', 'failed'],
  ]) {
    const plan = template();
    const job = { quotaDate: '2026-10-06', limits: {}, error };
    finishSchedule(plan, job, { success: false, error });
    assert.equal(plan.usage['2026-10-06'].outcome, expected);
    assert.equal(job.status, expected === 'failed' ? 'failed' : 'limited');
    assert.equal(Boolean(exhausted(plan, plan.usage['2026-10-06'])), expected !== 'failed');
  }
  const plan = template();
  const job = { quotaDate: '2026-10-06', limits: {}, stopping: true, stopReason: 'shutdown' };
  finishSchedule(plan, job, { success: false, error: 'context canceled' });
  assert.equal(plan.usage['2026-10-06'].outcome, 'interrupted');
  assert.equal(due(plan, now), true);
});
