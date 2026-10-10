import test from 'node:test';
import assert from 'node:assert/strict';
import {
  account,
  due,
  finishSchedule,
  scheduleView,
  usage,
  validateSchedule,
} from '../server/scheduling.mjs';

const now = Date.parse('2026-10-10T10:00:00+08:00');
const template = () => ({
  id: 'plan',
  name: '影视监控',
  mode: 'copy',
  enabled: true,
  source: { remote: '115', path: '电影' },
  destination: { remote: 'google', path: '库' },
  startTime: '01:00',
  timezone: 'Asia/Shanghai',
  dailyBytes: 1000,
  dailySeconds: 100,
  cutoffMode: 'hard',
  scanIntervalMinutes: 15,
  usage: {},
});
function complete(schedule, at, bytes) {
  const job = { quotaDate: '2026-10-10', createdAt: new Date(at).toISOString(), limits: {} };
  schedule.runningJobId = 'job';
  account(schedule, job, { bytes }, {}, at + 1000);
  finishSchedule(schedule, job, { success: true, endTime: new Date(at + 1000).toISOString() });
}

test('保存多个来源目录与影视设置和扫描间隔，拒绝无效间隔', () => {
  const schedule = validateSchedule({
    ...template(),
    sourcePaths: ['电影', '剧集'],
    media: { enabled: true, preset: 'bundle' },
    filters: { exclude: ['*.tmp'] },
  });
  assert.equal(schedule.scanIntervalMinutes, 15);
  assert.deepEqual(schedule.sourcePaths, ['电影', '剧集']);
  assert.equal(schedule.media.preset, 'bundle');
  assert.deepEqual(schedule.filters.exclude, ['*.tmp']);
  assert.equal(
    validateSchedule({ ...template(), scanIntervalMinutes: undefined }).scanIntervalMinutes,
    0,
  );
  for (const value of [-1, 1, 4, 1441, 5.5, 'not a number'])
    assert.throws(() => validateSchedule({ ...template(), scanIntervalMinutes: value }));
});

test('每次完成后等待间隔，共享同一天容量与时长，重启和启停不清额度', () => {
  let schedule = template();
  complete(schedule, now, 300);
  assert.equal(due(schedule, now + 15 * 60000), false);
  assert.equal(due(schedule, now + 15 * 60000 + 1000), true);
  assert.equal(scheduleView(schedule, now + 1000).nextRun, '2026-10-10 10:15');
  schedule = JSON.parse(JSON.stringify(schedule));
  schedule.enabled = false;
  assert.equal(due(schedule, now + 20 * 60000), false);
  schedule.enabled = true;
  assert.equal(due(schedule, now + 20 * 60000), true);
  complete(schedule, now + 20 * 60000, 400);
  assert.equal(usage(schedule, '2026-10-10').bytes, 700);
  assert.equal(usage(schedule, '2026-10-10').seconds, 2);
  schedule.runningJobId = 'pending';
  assert.equal(due(schedule, now + 40 * 60000), false);
  assert.equal(scheduleView(schedule, now + 40 * 60000).nextRun, null);
  schedule.runningJobId = null;
  complete(schedule, now + 40 * 60000, 300);
  assert.equal(due(schedule, now + 60 * 60000), false);
  assert.equal(scheduleView(schedule, now + 60 * 60000).nextRun, '2026-10-11 01:00');
  assert.equal(due(schedule, now + 86400000), true);
  assert.equal(scheduleView(schedule, now + 86400000).today.bytes, 0);
  assert.equal(schedule.usage['2026-10-10'].bytes, 1000);
});

test('每日一次保持原行为，间隔扫描遵守开始时间和暂停结果', () => {
  const schedule = template();
  schedule.scanIntervalMinutes = 0;
  complete(schedule, now, 100);
  assert.equal(due(schedule, now + 60 * 60000), false);
  schedule.scanIntervalMinutes = 15;
  assert.equal(due(schedule, Date.parse('2026-10-10T00:59:00+08:00')), false);
  schedule.usage['2026-10-10'].outcome = 'paused';
  assert.equal(due(schedule, now + 60 * 60000), false);
});

test('容量未耗尽但时长已满也不能启动下一轮', () => {
  const schedule = template();
  complete(schedule, now, 100);
  usage(schedule, '2026-10-10').seconds = 100;
  assert.equal(due(schedule, now + 60 * 60000), false);
});

test('重复检查可不设每日限额，每日一次仍需设置额度或时长', () => {
  const schedule = validateSchedule({ ...template(), dailyBytes: 0, dailySeconds: 0 });
  assert.equal(schedule.dailyBytes, 0);
  assert.equal(schedule.dailySeconds, 0);
  schedule.usage = {};
  complete(schedule, now, 10000);
  assert.equal(due(schedule, now + 20 * 60000), true);
  assert.throws(() =>
    validateSchedule({ ...template(), dailyBytes: 0, dailySeconds: 0, scanIntervalMinutes: 0 }),
  );
});
