import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPanel } from '../server/app.mjs';

const binary = process.env.RCLONE_BIN || 'rclone';
const installed = spawnSync(binary, ['version'], { windowsHide: true }).status === 0;
test(
  '真实 rclone 每日限量、限时、跨日继续和重启记账',
  { skip: !installed, timeout: 60000 },
  async (t) => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'rclone-schedule-integration-'));
    assert.ok(fixture.startsWith(path.join(os.tmpdir(), 'rclone-schedule-integration-')));
    const root = path.join(fixture, 'files');
    await mkdir(path.join(root, 'source'), { recursive: true });
    for (const name of ['a.bin', 'b.bin', 'c.bin'])
      await writeFile(
        path.join(root, 'source', name),
        Buffer.alloc(256 * 1024, name.charCodeAt(0)),
      );
    await mkdir(path.join(root, 'slow'), { recursive: true });
    await writeFile(path.join(root, 'slow', 'large.bin'), Buffer.alloc(2 * 1024 ** 2, 42));
    let clock = Date.parse('2026-10-06T02:00:00+08:00');
    const options = {
      HOST: '127.0.0.1',
      PANEL_PASSWORD: '',
      RCLONE_BIN: binary,
      DATA_DIR: path.join(fixture, 'panel'),
      LOCAL_ROOT: root,
      RCLONE_CONFIG: path.join(fixture, 'config', 'rclone.conf'),
      now: () => clock,
    };
    let panel, server, base;
    async function start() {
      panel = await createPanel(options);
      assert.equal(panel.engine.ready, true, panel.engine.error);
      server = await new Promise((resolve) => {
        const s = panel.app.listen(0, '127.0.0.1', () => resolve(s));
      });
      base = `http://127.0.0.1:${server.address().port}/api`;
    }
    async function call(url, method = 'GET', body) {
      const response = await fetch(base + url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    }
    async function close() {
      await panel.close();
      await new Promise((resolve) => server.close(resolve));
    }
    async function finish(id) {
      for (let i = 0; i < 200; i++) {
        await panel.tick();
        const job = (await call('/jobs')).data.find((item) => item.id === id);
        if (job.status !== 'running') return job;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      throw new Error('计划任务没有及时结束');
    }
    const config = {
      name: '软限额测试',
      mode: 'copy',
      enabled: false,
      timezone: 'Asia/Shanghai',
      startTime: '01:00',
      source: { remote: 'local', path: 'source' },
      destination: { remote: 'local', path: 'soft-target' },
      dailyBytes: 300 * 1024,
      dailySeconds: 0,
      cutoffMode: 'soft',
    };
    let soft;
    try {
      await start();
      await call('/settings', 'PUT', { transfers: 1, checkers: 1, retries: 1, bandwidth: '' });
      await t.test('验证目录和删除确认；不允许相互嵌套的计划', async () => {
        assert.equal((await call('/schedules', 'POST', { ...config, mode: 'sync' })).status, 400);
        assert.equal(
          (
            await call('/schedules', 'POST', {
              ...config,
              destination: { remote: 'local', path: 'source/sub' },
            })
          ).status,
          400,
        );
        assert.equal(
          (await call('/schedules', 'POST', { ...config, timezone: 'fake/timezone' })).status,
          400,
        );
      });
      await t.test('软限额完成当前文件，阻止同日重跑和并发重复启动', async () => {
        const created = await call('/schedules', 'POST', config);
        assert.equal(created.status, 200, JSON.stringify(created.data));
        soft = created.data;
        const runs = await Promise.all([
          call(`/schedules/${soft.id}/run`, 'POST', {}),
          call(`/schedules/${soft.id}/run`, 'POST', {}),
        ]);
        assert.deepEqual(runs.map((r) => r.status).sort(), [200, 409], JSON.stringify(runs));
        const job = await finish(runs.find((r) => r.status === 200).data.id);
        assert.equal(job.status, 'limited', JSON.stringify(job));
        assert.equal(job.limitReason, 'bytes_limit');
        const plan = (await call('/schedules')).data.find((item) => item.id === soft.id);
        assert.ok(plan.today.bytes >= config.dailyBytes);
        assert.ok(
          (await readdir(path.join(root, 'soft-target'))).filter((name) => name.endsWith('.bin'))
            .length > 0,
        );
        assert.equal((await call(`/schedules/${soft.id}/run`, 'POST', {})).status, 409);
      });
      await t.test('服务重启保留当天额度；新一天自动继续并跳过已完成文件', async () => {
        const before = (await call('/schedules')).data.find((item) => item.id === soft.id).today
          .bytes;
        await close();
        await start();
        assert.equal(
          (await call('/schedules')).data.find((item) => item.id === soft.id).today.bytes,
          before,
        );
        assert.equal((await call(`/schedules/${soft.id}/run`, 'POST', {})).status, 409);
        const edited = await call(`/schedules/${soft.id}`, 'PUT', {
          ...config,
          name: '修改名称保留额度',
        });
        assert.equal(edited.status, 200);
        assert.equal(edited.data.today.bytes, before);
        assert.equal(
          (await call(`/schedules/${soft.id}`, 'PUT', { ...config, timezone: 'UTC' })).status,
          400,
        );
        await call(`/schedules/${soft.id}/toggle`, 'POST', { enabled: true });
        await panel.tick();
        assert.equal((await call('/jobs')).data.length, 1);
        clock += 86400000;
        await panel.tick();
        const job = (await call('/jobs')).data[0];
        assert.equal(job.scheduleId, soft.id);
        const ended = await finish(job.id);
        assert.equal(ended.status, 'completed', JSON.stringify(ended));
        assert.ok(ended.stats.bytes < 3 * 256 * 1024);
        for (const name of ['a.bin', 'b.bin', 'c.bin'])
          assert.deepEqual(
            await readFile(path.join(root, 'soft-target', name)),
            await readFile(path.join(root, 'source', name)),
          );
        await panel.tick();
        assert.equal((await call('/jobs')).data.length, 2);
      });
      await t.test('硬限额中断当前文件，截止被标记为限额而非失败', async () => {
        const created = await call('/schedules', 'POST', {
          ...config,
          name: '硬限额',
          dailyBytes: 128 * 1024,
          cutoffMode: 'hard',
          destination: { remote: 'local', path: 'hard-target' },
        });
        const started = await call(`/schedules/${created.data.id}/run`, 'POST', {});
        const job = await finish(started.data.id);
        assert.equal(job.status, 'limited', JSON.stringify(job));
        assert.equal((await call(`/schedules/${created.data.id}/run`, 'POST', {})).status, 409);
      });
      await t.test('每日时长在真实限速传输中生效', async () => {
        await call('/settings', 'PUT', {
          transfers: 1,
          checkers: 1,
          retries: 1,
          bandwidth: '128K',
        });
        const created = await call('/schedules', 'POST', {
          ...config,
          name: '限时',
          dailyBytes: 0,
          dailySeconds: 1,
          cutoffMode: 'hard',
          source: { remote: 'local', path: 'slow' },
          destination: { remote: 'local', path: 'time-target' },
        });
        const started = await call(`/schedules/${created.data.id}/run`, 'POST', {});
        const job = await finish(started.data.id);
        assert.equal(job.status, 'limited', JSON.stringify(job));
        assert.equal(job.limitReason, 'time_limit');
        assert.equal((await call(`/schedules/${created.data.id}/run`, 'POST', {})).status, 409);
      });
      await t.test('手动停用、同日重试扣除用量，跨日中断不会叠加并发', async () => {
        const created = await call('/schedules', 'POST', {
          ...config,
          name: '暂停重试',
          dailyBytes: 1024 ** 2,
          dailySeconds: 30,
          cutoffMode: 'hard',
          source: { remote: 'local', path: 'slow' },
          destination: { remote: 'local', path: 'retry-target' },
        });
        const started = await call(`/schedules/${created.data.id}/run`, 'POST', {});
        await new Promise((resolve) => setTimeout(resolve, 500));
        await call(`/schedules/${created.data.id}/toggle`, 'POST', { enabled: false });
        assert.equal((await finish(started.data.id)).status, 'stopped');
        const before = (await call('/schedules')).data.find(
          (item) => item.id === created.data.id,
        ).today;
        assert.ok(before.seconds > 0);
        const restarted = await call(`/schedules/${created.data.id}/run`, 'POST', {});
        assert.ok(restarted.data.limits.seconds < 30);
        assert.equal(restarted.data.limits.bytes, 1024 ** 2 - before.bytes);
        clock += 86400000;
        const ended = await finish(restarted.data.id);
        assert.equal(ended.limitReason, 'rollover');
        const plan = (await call('/schedules')).data.find((item) => item.id === created.data.id);
        assert.equal(plan.today.bytes, 0);
        assert.equal(plan.runningJobId, null);
      });
      await t.test('正在运行的计划正常重启后自动恢复，剩余额度继续生效', async () => {
        const created = await call('/schedules', 'POST', {
          ...config,
          name: '重启恢复',
          dailyBytes: 1024 ** 2,
          dailySeconds: 30,
          cutoffMode: 'hard',
          source: { remote: 'local', path: 'slow' },
          destination: { remote: 'local', path: 'recovery-target' },
        });
        const started = await call(`/schedules/${created.data.id}/run`, 'POST', {});
        assert.equal(started.status, 200, JSON.stringify(started.data));
        await call(`/schedules/${created.data.id}/toggle`, 'POST', { enabled: true });
        await new Promise((resolve) => setTimeout(resolve, 350));
        await panel.tick();
        const before = (await call('/schedules')).data.find(
          (item) => item.id === created.data.id,
        ).today;
        await close();
        await start();
        const restored = (await call('/schedules')).data.find(
          (item) => item.id === created.data.id,
        );
        assert.ok(restored.today.bytes >= before.bytes);
        assert.ok(restored.today.seconds >= before.seconds);
        await panel.tick();
        const active = (await call('/jobs')).data.find(
          (item) => item.scheduleId === created.data.id && item.status === 'running',
        );
        assert.ok(active, JSON.stringify((await call('/schedules')).data));
        // A slow shutdown can persist the interrupted job and resume it on startup.
        assert.ok(
          active.id !== started.data.id || active.attempts > started.data.attempts,
          JSON.stringify(active),
        );
        assert.equal(active.limits.bytes, 1024 ** 2 - restored.today.bytes);
        assert.ok(active.limits.seconds < 30);
        await call(`/schedules/${created.data.id}/toggle`, 'POST', { enabled: false });
        assert.equal((await finish(active.id)).status, 'stopped');
      });
    } finally {
      if (panel) await panel.close();
      if (server?.listening) await new Promise((resolve) => server.close(resolve));
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
