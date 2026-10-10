import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPanel } from '../server/app.mjs';

const binary = process.env.RCLONE_BIN || 'rclone';
const installed = spawnSync(binary, ['version'], { windowsHide: true }).status === 0;

test('真实 rclone 配置与文件传输', { skip: !installed, timeout: 45000 }, async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'rclone-studio-integration-'));
  const root = path.join(fixture, 'files');
  await mkdir(path.join(root, 'source'), { recursive: true });
  await mkdir(path.join(root, 'target'), { recursive: true });
  await writeFile(path.join(root, 'source', '测试.txt'), 'real rclone transfer\n');
  await writeFile(path.join(root, 'target', 'keep.txt'), 'keep until sync\n');
  const options = {
    HOST: '127.0.0.1',
    RCLONE_BIN: binary,
    PANEL_PASSWORD: 'synthetic-test-password-only',
    DATA_DIR: path.join(fixture, 'panel'),
    LOCAL_ROOT: root,
    RCLONE_CONFIG: path.join(fixture, 'config', 'rclone.conf'),
  };
  let panel,
    server,
    base,
    cookie = '';
  async function start() {
    panel = await createPanel(options);
    assert.equal(panel.engine.ready, true, panel.engine.error);
    server = await new Promise((resolve) => {
      const server = panel.app.listen(0, '127.0.0.1', () => resolve(server));
    });
    base = `http://127.0.0.1:${server.address().port}/api`;
  }
  async function call(endpoint, method = 'GET', body) {
    const response = await fetch(`${base}${endpoint}`, {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json();
    return { status: response.status, data: json, response };
  }
  async function login() {
    const result = await call('/login', 'POST', { password: options.PANEL_PASSWORD });
    assert.equal(result.status, 200);
    cookie = result.response.headers.get('set-cookie').split(';')[0];
    assert.match(result.response.headers.get('set-cookie'), /HttpOnly/i);
  }
  async function finish(id) {
    for (let i = 0; i < 100; i++) {
      const { data } = await call('/jobs');
      const job = data.find((job) => job.id === id);
      if (job.status !== 'running') {
        assert.equal(job.status, 'completed', job.error);
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('任务没有及时结束');
  }
  async function close() {
    await panel.close();
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    await start();
    await t.test('未登录请求被拒绝，错误密码无效', async () => {
      assert.equal((await call('/remotes')).status, 401);
      assert.equal((await call('/login', 'POST', { password: 'wrong' })).status, 401);
      await login();
    });
    await t.test('拒绝跨站请求', async () => {
      const response = await fetch(`${base}/settings`, {
        method: 'PUT',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
          Origin: 'https://other.example',
        },
        body: '{}',
      });
      assert.equal(response.status, 403);
    });
    await t.test('读取真实后端字段，创建本地和 WebDAV 配置', async () => {
      const { data } = await call('/providers');
      assert.ok(data.some((provider) => provider.name === 'webdav'));
      assert.equal(
        (
          await call('/remotes', 'POST', {
            name: 'disk',
            type: 'local',
            parameters: { description: '本地测试' },
          })
        ).status,
        200,
      );
      const created = await call('/remotes', 'POST', {
        name: 'dav',
        type: 'webdav',
        parameters: {
          url: 'https://example.invalid/dav/',
          user: 'synthetic-user',
          pass: 'longBase64LookingPassword123456789',
        },
      });
      assert.equal(created.status, 200, JSON.stringify(created.data));
      assert.equal(
        (await call('/remotes', 'POST', { name: 'dav', type: 'local', parameters: {} })).status,
        409,
      );
    });
    await t.test('密码正确混淆，修改配置保留原凭据', async () => {
      const before = (await panel.engine.call('config/dump')).dav.pass;
      assert.notEqual(before, 'longBase64LookingPassword123456789');
      assert.equal(
        (await call('/remotes/dav', 'PUT', { parameters: { description: '改备注' } })).status,
        200,
      );
      assert.equal((await panel.engine.call('config/dump')).dav.pass, before);
      const list = (await call('/remotes')).data;
      assert.ok(list.find((remote) => remote.name === 'dav').configuredSecrets.includes('pass'));
      assert.ok(!JSON.stringify(list).includes(before));
      assert.ok(!JSON.stringify(list).includes('longBase64LookingPassword123456789'));
    });
    await t.test('浏览中文文件和新建文件夹，拒绝路径穿越', async () => {
      const listing = await call('/files?remote=local&path=source');
      assert.equal(listing.status, 200);
      assert.equal(listing.data.items[0].Name, '测试.txt');
      assert.equal((await call('/files?remote=local&path=../config')).status, 400);
      assert.equal(
        (await call('/files/mkdir', 'POST', { remote: 'local', path: 'new-folder' })).status,
        200,
      );
      assert.ok((await readdir(root)).includes('new-folder'));
      assert.equal((await call('/remotes/disk/test', 'POST', {})).status, 200);
    });
    const endpoints = {
      source: { remote: 'local', path: 'source' },
      destination: { remote: 'local', path: 'target' },
    };
    await t.test('目录复制真实写入，保留目标额外文件', async () => {
      const result = await call('/jobs', 'POST', { ...endpoints, mode: 'copy', name: '复制测试' });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      await finish(result.data.id);
      assert.equal(
        await readFile(path.join(root, 'target', '测试.txt'), 'utf8'),
        'real rclone transfer\n',
      );
      assert.equal(
        await readFile(path.join(root, 'target', 'keep.txt'), 'utf8'),
        'keep until sync\n',
      );
    });
    await t.test('同步预演不删除文件；真实同步必须确认', async () => {
      const preview = await call('/jobs', 'POST', { ...endpoints, mode: 'sync', dryRun: true });
      assert.equal(preview.status, 200, JSON.stringify(preview.data));
      await finish(preview.data.id);
      assert.equal(
        await readFile(path.join(root, 'target', 'keep.txt'), 'utf8'),
        'keep until sync\n',
      );
      assert.equal((await call('/jobs', 'POST', { ...endpoints, mode: 'sync' })).status, 400);
      const sync = await call('/jobs', 'POST', { ...endpoints, mode: 'sync', confirmDelete: true });
      assert.equal(sync.status, 200, JSON.stringify(sync.data));
      await finish(sync.data.id);
      assert.deepEqual(await readdir(path.join(root, 'target')), ['测试.txt']);
    });
    await t.test('拒绝相同或嵌套的源目标目录', async () => {
      assert.equal(
        (
          await call('/jobs', 'POST', {
            mode: 'copy',
            source: { remote: 'local', path: '' },
            destination: { remote: 'disk', path: 'target' },
          })
        ).status,
        400,
      );
    });
    await t.test('停止正在传输的任务', async () => {
      await mkdir(path.join(root, 'slow-source'));
      await writeFile(path.join(root, 'slow-source', 'large.bin'), Buffer.alloc(1024 * 1024, 65));
      assert.equal(
        (
          await call('/settings', 'PUT', {
            transfers: 1,
            checkers: 1,
            retries: 1,
            bandwidth: '128K',
          })
        ).status,
        200,
      );
      const task = await call('/jobs', 'POST', {
        mode: 'copy',
        source: { remote: 'local', path: 'slow-source' },
        destination: { remote: 'local', path: 'slow-target' },
      });
      assert.equal(task.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal((await call(`/jobs/${task.data.id}/stop`, 'POST', {})).status, 200);
      for (let i = 0; i < 50; i++) {
        const job = (await call('/jobs')).data.find((job) => job.id === task.data.id);
        if (job.status !== 'running') {
          assert.equal(job.status, 'stopped');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('停止任务未及时完成');
    });
    await t.test('运行设置持久化，配置修改有备份', async () => {
      assert.equal(
        (await call('/settings', 'PUT', { transfers: 2, checkers: 4, retries: 2, bandwidth: '5M' }))
          .status,
        200,
      );
      assert.ok((await readdir(path.join(fixture, 'panel', 'backups'))).length >= 1);
      const jobs = (await call('/jobs')).data;
      assert.equal(jobs.length, 4);
      await close();
      await start();
      cookie = '';
      await login();
      assert.equal((await call('/settings')).data.bandwidth, '5M');
      assert.equal((await call('/jobs')).data.length, 4);
      assert.equal((await call('/remotes/dav', 'DELETE', {})).status, 200);
      assert.equal((await call('/remotes')).data.length, 1);
    });
    await t.test('退出登录使会话失效', async () => {
      assert.equal((await call('/logout', 'POST', {})).status, 200);
      assert.equal((await call('/settings')).status, 401);
    });
  } finally {
    if (panel) await panel.close();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await rm(fixture, { recursive: true, force: true });
  }
});
