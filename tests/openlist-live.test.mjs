import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, chmod, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPanel } from '../server/app.mjs';

const binary = process.env.RCLONE_BIN || 'rclone';
const url = process.env.OPENLIST_TEST_URL;
const filesRoot = process.env.OPENLIST_TEST_FILES;
const installed = spawnSync(binary, ['version'], { windowsHide: true }).status === 0;
test(
  '真实 OpenList WebDAV 跨存储复制、删除配置保留文件和每日跨日续传',
  { skip: !(installed && url && filesRoot), timeout: 45000 },
  async (t) => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'rclone-openlist-live-'));
    const runName = `studio-live-${randomBytes(8).toString('hex')}`;
    const runRoot = path.resolve(filesRoot, runName);
    assert.equal(path.dirname(runRoot), path.resolve(filesRoot));
    await mkdir(path.join(runRoot, 'source'), { recursive: true });
    await mkdir(path.join(runRoot, 'target'), { recursive: true });
    // Fixture is shared by the test runner (UID 1000) and OpenList (UID 1001).
    await chmod(path.join(runRoot, 'target'), 0o777);
    await writeFile(path.join(runRoot, 'source/中文文件.txt'), 'OpenList to rclone to OpenList\n');
    let panel,
      server,
      base,
      auth,
      userId,
      davAuth,
      targetId,
      inspectionReady = false;
    const ids = [];
    let now = Date.parse('2026-10-06T02:00:00+08:00');
    const password = process.env.OPENLIST_TEST_PASSWORD;
    const adminUser = process.env.OPENLIST_TEST_USER || 'admin';
    async function upstream(route, body) {
      const res = await fetch(url + '/api' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json();
      assert.equal(data.code, 200, `OpenList API ${route} failed (code ${data.code})`);
      return data.data;
    }
    async function call(route, method = 'GET', body) {
      const res = await fetch(base + route, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json();
      assert.equal(res.status, 200, JSON.stringify(data));
      return data;
    }
    async function finish(id) {
      for (let i = 0; i < 250; i++) {
        await panel.tick();
        const job = (await call('/jobs')).find((job) => job.id === id);
        if (job.status !== 'running') return job;
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      throw new Error('WebDAV transfer did not finish');
    }
    async function targetContents() {
      const res = await fetch(
        `${url}/dav/inspection/target/${encodeURIComponent('中文文件.txt')}`,
        { headers: { Authorization: davAuth } },
      );
      assert.equal(res.status, 200);
      return Buffer.from(await res.arrayBuffer());
    }
    try {
      panel = await createPanel({
        HOST: '127.0.0.1',
        PANEL_PASSWORD: '',
        RCLONE_BIN: binary,
        DATA_DIR: path.join(fixture, 'panel'),
        LOCAL_ROOT: path.join(fixture, 'files'),
        RCLONE_CONFIG: path.join(fixture, 'config/rclone.conf'),
        now: () => now,
      });
      assert.equal(panel.engine.ready, true, panel.engine.error);
      server = await new Promise((resolve) => {
        const s = panel.app.listen(0, '127.0.0.1', () => resolve(s));
      });
      base = `http://127.0.0.1:${server.address().port}/api`;
      await call('/openlist', 'PUT', { url, username: adminUser, password });
      auth = (
        await upstream('/auth/login/hash', {
          username: adminUser,
          password: createHash('sha256')
            .update(`${password}-https://github.com/alist-org/alist`)
            .digest('hex'),
        })
      ).token;
      const state = JSON.parse(await readFile(path.join(fixture, 'panel/state.json'), 'utf8'));
      const managed = {};
      davAuth = `Basic ${Buffer.from(`${state.openlist.davUser}:${state.openlist.davPassword}`).toString('base64')}`;
      userId = (await upstream('/admin/user/list')).content.find(
        (u) => u.username === state.openlist.davUser,
      ).id;
      // Local drivers stand in for external cloud accounts. Both ends use the real OpenList WebDAV service.
      for (const name of ['source', 'target']) {
        const storage = await upstream('/admin/storage/create', {
          mount_path: `${state.openlist.namespace}/${name}`,
          driver: 'Local',
          addition: JSON.stringify({
            root_folder_path: `${process.env.OPENLIST_TEST_STORAGE_ROOT || '/verify-files'}/${runName}/${name}`,
            mkdir_perm: '777',
            show_hidden: true,
          }),
          cache_expiration: 1,
          webdav_policy: 'native_proxy',
        });
        ids.push(storage.id);
        if (name === 'target') targetId = storage.id;
        managed[`dav-${name}`] = {
          name: `dav-${name}`,
          type: 'openlist-115',
          mode: 'cookie',
          driver: 'Local',
          storageId: storage.id,
          mountPath: `${state.openlist.namespace}/${name}`,
          phase: 'ready',
          capabilities: { upload: true, overwrite: true },
        };
        await call('/remotes', 'POST', {
          name: `dav-${name}`,
          type: 'webdav',
          parameters: {
            url: `${url}/dav/${name}/`,
            vendor: 'other',
            user: state.openlist.davUser,
            pass: state.openlist.davPassword,
          },
        });
      }
      const inspection = await upstream('/admin/storage/create', {
        mount_path: `${state.openlist.namespace}/inspection`,
        driver: 'Local',
        addition: JSON.stringify({
          root_folder_path: `${process.env.OPENLIST_TEST_STORAGE_ROOT || '/verify-files'}/${runName}`,
          mkdir_perm: '777',
          show_hidden: true,
        }),
        cache_expiration: 1,
        webdav_policy: 'native_proxy',
      });
      ids.push(inspection.id);
      inspectionReady = true;
      // Install isolated fixture mappings so transfers exercise managed-remotes config too.
      await panel.close();
      await new Promise((resolve) => server.close(resolve));
      const saved = JSON.parse(await readFile(path.join(fixture, 'panel/state.json'), 'utf8'));
      saved.cloudRemotes = managed;
      await writeFile(path.join(fixture, 'panel/state.json'), JSON.stringify(saved));
      panel = await createPanel({
        HOST: '127.0.0.1',
        PANEL_PASSWORD: '',
        RCLONE_BIN: binary,
        DATA_DIR: path.join(fixture, 'panel'),
        LOCAL_ROOT: path.join(fixture, 'files'),
        RCLONE_CONFIG: path.join(fixture, 'config/rclone.conf'),
        now: () => now,
      });
      server = await new Promise((resolve) => {
        const s = panel.app.listen(0, '127.0.0.1', () => resolve(s));
      });
      base = `http://127.0.0.1:${server.address().port}/api`;
      const endpoints = {
        source: { remote: 'dav-source', path: '' },
        destination: { remote: 'dav-target', path: '' },
      };
      await t.test('服务端创建的专用账号具有 WebDAV 读写权限，中文文件复制一致', async () => {
        assert.equal((await call('/files?remote=dav-source')).items[0].Name, '中文文件.txt');
        const job = await call('/jobs', 'POST', { ...endpoints, mode: 'copy' });
        const finished = await finish(job.id);
        assert.equal(finished.status, 'completed', finished.error);
        assert.deepEqual(
          await targetContents(),
          await readFile(path.join(runRoot, 'source/中文文件.txt')),
        );
      });
      await t.test('每日限额在两个 WebDAV 存储之间生效，次日跳过已完成文件继续', async () => {
        await mkdir(path.join(runRoot, 'source/daily'));
        for (const name of ['a.bin', 'b.bin', 'c.bin'])
          await writeFile(
            path.join(runRoot, 'source/daily', name),
            Buffer.alloc(40 * 1024, name.charCodeAt(0)),
          );
        await call('/settings', 'PUT', { transfers: 1, checkers: 1, retries: 1, bandwidth: '' });
        const plan = await call('/schedules', 'POST', {
          name: 'WebDAV 每日互传',
          mode: 'copy',
          source: { remote: 'dav-source', path: 'daily' },
          destination: { remote: 'dav-target', path: 'daily' },
          enabled: false,
          timezone: 'Asia/Shanghai',
          startTime: '01:00',
          dailyBytes: 70 * 1024,
          dailySeconds: 10,
          cutoffMode: 'soft',
        });
        const first = await call(`/schedules/${plan.id}/run`, 'POST', {});
        const dayOne = await finish(first.id);
        assert.equal(dayOne.status, 'limited', dayOne.error);
        assert.equal((await call('/files?remote=dav-target&path=daily')).items.length, 2);
        const used = (await call('/schedules')).find((p) => p.id === plan.id).today.bytes;
        assert.ok(used >= 70 * 1024);
        now += 24 * 3600 * 1000;
        const second = await call(`/schedules/${plan.id}/run`, 'POST', {});
        const dayTwo = await finish(second.id);
        assert.equal(dayTwo.status, 'completed', dayTwo.error);
        assert.equal(dayTwo.stats.bytes, 40 * 1024);
        assert.equal((await call('/files?remote=dav-target&path=daily')).items.length, 3);
        await call(`/schedules/${plan.id}`, 'DELETE', {});
      });
      await t.test('真实 OpenList 挂载与授权完整加密备份后可恢复，文件内容保持一致', async () => {
        const passphrase = 'synthetic-live-backup-password';
        const archive = await call('/backups/export', 'POST', { passphrase });
        assert.equal(
          (await call('/backups/inspect', 'POST', { archive, passphrase })).cloudAccounts,
          2,
        );
        await call('/backups/restore', 'POST', { archive, passphrase, confirmRestore: true });
        assert.equal((await call('/files?remote=dav-target&path=daily')).items.length, 3);
        assert.equal((await targetContents()).toString('utf8'), 'OpenList to rclone to OpenList\n');
      });
      await t.test('删除连接和 OpenList 挂载后，目标文件仍然存在', async () => {
        await call('/remotes/dav-target', 'DELETE', {});
        ids.splice(ids.indexOf(targetId), 1);
        assert.ok(!(await upstream('/admin/storage/list')).content.some((s) => s.id === targetId));
        assert.equal((await targetContents()).toString('utf8'), 'OpenList to rclone to OpenList\n');
      });
    } finally {
      if (panel) await panel.close();
      if (server?.listening) await new Promise((resolve) => server.close(resolve));
      // Uploads are private to OpenList UID 1001 (UMASK 077). Read and clean through WebDAV.
      if (inspectionReady)
        for (const name of ['daily/', encodeURIComponent('中文文件.txt')]) {
          const res = await fetch(`${url}/dav/inspection/target/${name}`, {
            method: 'DELETE',
            headers: { Authorization: davAuth },
          });
          assert.ok([200, 204, 404].includes(res.status), `Fixture cleanup HTTP ${res.status}`);
        }
      if (auth) {
        for (const id of ids) await upstream(`/admin/storage/delete?id=${id}`, {});
        if (userId) await upstream(`/admin/user/delete?id=${userId}`, {});
      }
      assert.equal(path.dirname(runRoot), path.resolve(filesRoot));
      await rm(runRoot, { recursive: true, force: true });
      assert.ok(fixture.startsWith(path.join(os.tmpdir(), 'rclone-openlist-live-')));
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
