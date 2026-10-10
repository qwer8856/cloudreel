import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPanel } from '../server/app.mjs';
import { mockOpenList } from './helpers/openlist.mjs';

const binary = process.env.RCLONE_BIN || 'rclone';
const installed = spawnSync(binary, ['version'], { windowsHide: true }).status === 0;
test(
  '真实 rclone 配置与网盘 API、计划引用和运行任务保护',
  { skip: !installed, timeout: 25000 },
  async (t) => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'rclone-cloud-integration-'));
    const mock = await mockOpenList();
    let panel, server, base;
    const options = {
      HOST: '127.0.0.1',
      PANEL_PASSWORD: '',
      RCLONE_BIN: binary,
      DATA_DIR: path.join(fixture, 'panel'),
      LOCAL_ROOT: path.join(fixture, 'files'),
      RCLONE_CONFIG: path.join(fixture, 'config/rclone.conf'),
      now: () => Date.parse('2026-10-06T00:00:00+08:00'),
    };
    async function start() {
      panel = await createPanel(options);
      assert.equal(panel.engine.ready, true, panel.engine.error);
      server = await new Promise((resolve) => {
        const s = panel.app.listen(0, '127.0.0.1', () => resolve(s));
      });
      base = `http://127.0.0.1:${server.address().port}/api`;
    }
    async function call(route, method = 'GET', body) {
      const res = await fetch(base + route, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, data: await res.json() };
    }
    async function close() {
      await panel.close();
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      await start();
      await t.test('服务设置不回显管理员密码或专用 WebDAV 凭据', async () => {
        const config = await call('/openlist', 'PUT', {
          url: mock.url,
          username: 'admin',
          password: 'synthetic-admin-password',
        });
        assert.equal(config.status, 200, JSON.stringify(config.data));
        assert.equal(config.data.ready, true);
        assert.ok(
          !JSON.stringify((await call('/openlist')).data).includes('synthetic-admin-password'),
        );
      });
      await t.test('创建网盘时保存混淆的 WebDAV 密码，列表展示真实网盘类型', async () => {
        const result = await call('/cloud-remotes', 'POST', {
          name: 'source',
          type: 'openlist-115',
          mode: 'cookie',
          parameters: { cookie: 'synthetic-cookie' },
        });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        const config = (await panel.engine.call('config/dump')).source;
        const stored = JSON.parse(await readFile(path.join(fixture, 'panel/state.json'), 'utf8'));
        assert.equal(config.type, 'webdav');
        assert.notEqual(config.pass, stored.openlist.davPassword);
        assert.ok(!JSON.stringify((await call('/remotes')).data).includes(config.pass));
        assert.equal(
          (await call('/remotes')).data.find((r) => r.name === 'source').type,
          'openlist-115',
        );
        assert.deepEqual(
          (await call('/providers')).data.filter((p) => p.managed).map((p) => p.name),
          ['openlist-115', 'openlist-guangya', 'openlist-123', 'drive-group'],
        );
        assert.equal((await call('/remotes/source', 'PUT', { parameters: {} })).status, 400);
      });
      await t.test('未完成登录的网盘不可用作任务端点，重复名称被拒绝', async () => {
        const pending = await call('/cloud-remotes', 'POST', {
          name: 'target',
          type: 'openlist-guangya',
          mode: 'sms',
          parameters: { client_id: 'client', phone_number: '13800000000' },
          action: 'send-code',
        });
        assert.equal(pending.status, 200, JSON.stringify(pending.data));
        assert.equal(pending.data.phase, 'sms');
        assert.equal(
          (
            await call('/jobs', 'POST', {
              mode: 'copy',
              source: { remote: 'source', path: '' },
              destination: { remote: 'target', path: '' },
            })
          ).status,
          400,
        );
        assert.equal(
          (await call('/remotes', 'POST', { name: 'target', type: 'local', parameters: {} }))
            .status,
          409,
        );
        assert.equal(
          (await call('/cloud-remotes/target', 'PUT', { parameters: { verify_code: '123456' } }))
            .data.phase,
          'ready',
        );
      });
      await t.test('光鸭作为目标拒绝同步，只复制新文件并禁用服务器端复制', async () => {
        const endpoints = {
          source: { remote: 'source', path: '' },
          destination: { remote: 'target', path: '' },
        };
        assert.equal(
          (await call('/jobs', 'POST', { ...endpoints, mode: 'sync', dryRun: true })).status,
          400,
        );
        const original = panel.engine.call.bind(panel.engine);
        let captured,
          stopped = false;
        panel.engine.call = async (endpoint, input) => {
          if (endpoint === 'sync/copy') {
            captured = input;
            return { jobid: 999999 };
          }
          if (endpoint === 'job/status' && input.jobid === 999999)
            return { finished: stopped, success: false, error: stopped ? 'context canceled' : '' };
          if (endpoint === 'job/stop' && input.jobid === 999999) {
            stopped = true;
            return {};
          }
          return original(endpoint, input);
        };
        const result = await call('/jobs', 'POST', { ...endpoints, mode: 'copy' });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        assert.equal(captured._config.IgnoreExisting, true);
        assert.deepEqual(captured._config.DisableFeatures, ['Copy', 'Move']);
        assert.equal((await call('/cloud-remotes/source', 'PUT', { parameters: {} })).status, 409);
        assert.equal((await call('/remotes/target', 'DELETE', {})).status, 409);
        await call(`/jobs/${result.data.id}/stop`, 'POST', {});
        await panel.tick();
        panel.engine.call = original;
      });
      let plan;
      await t.test('网盘互传可设置每日计划，启用的计划阻止修改登录', async () => {
        const result = await call('/schedules', 'POST', {
          name: '互传计划',
          mode: 'copy',
          source: { remote: 'source', path: '' },
          destination: { remote: 'target', path: '' },
          enabled: true,
          timezone: 'Asia/Shanghai',
          startTime: '23:00',
          dailyBytes: 1024 ** 3,
          dailySeconds: 3600,
          cutoffMode: 'soft',
        });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        plan = result.data;
        assert.equal((await call('/cloud-remotes/source', 'PUT', { parameters: {} })).status, 409);
        assert.equal(
          (await call('/openlist', 'PUT', { url: mock.url, username: 'admin', password: '' }))
            .status,
          409,
        );
        assert.equal((await call('/remotes/source', 'DELETE', {})).status, 409);
        assert.equal(
          (await call(`/schedules/${plan.id}/toggle`, 'POST', { enabled: false })).status,
          200,
        );
        assert.equal(
          (
            await call('/cloud-remotes/source', 'PUT', {
              parameters: { cookie: '' },
              description: '保留 Cookie',
            })
          ).status,
          200,
        );
        assert.equal((await call('/remotes/source', 'DELETE', {})).status, 409);
      });
      await t.test('驱动不支持上传时禁止成为目标', async () => {
        mock.readOnly(true);
        const result = await call('/cloud-remotes', 'POST', {
          name: 'readonly',
          type: 'openlist-123',
          mode: 'developer',
          parameters: { client_id: 'client', client_secret: 'synthetic-secret' },
        });
        assert.equal(result.data.capabilities.upload, false);
        assert.equal(
          (
            await call('/jobs', 'POST', {
              mode: 'copy',
              source: { remote: 'source', path: '' },
              destination: { remote: 'readonly', path: '' },
            })
          ).status,
          400,
        );
        mock.readOnly(false);
      });
      await t.test('重启保留网盘映射和计划，编辑不返回凭据', async () => {
        await close();
        await start();
        assert.equal((await call('/remotes')).data.length, 3);
        assert.equal((await call('/schedules')).data.length, 1);
        const view = await call('/cloud-remotes/source');
        assert.equal(view.status, 200);
        assert.ok(view.data.configuredSecrets.includes('cookie'));
        assert.ok(!JSON.stringify(view.data).includes('synthetic-cookie'));
        assert.equal((await call(`/schedules/${plan.id}`, 'DELETE', {})).status, 200);
        assert.equal((await call('/remotes/source', 'DELETE', {})).status, 200);
        assert.equal((await call('/remotes')).data.length, 2);
      });
    } finally {
      if (panel) await panel.close();
      if (server?.listening) await new Promise((resolve) => server.close(resolve));
      await mock.close();
      assert.ok(fixture.startsWith(path.join(os.tmpdir(), 'rclone-cloud-integration-')));
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
