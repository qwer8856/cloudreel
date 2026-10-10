import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPanel } from '../server/app.mjs';
import { mockCd2 } from './helpers/cd2.mjs';

const binary = process.env.RCLONE_BIN || 'rclone';
const installed = spawnSync(binary, ['version']).status === 0;
const wait = () => new Promise((resolve) => setTimeout(resolve, 25));
test(
  '真实 rclone：CD2 WebDAV 扫描复制到 group、额度切换、只读、密码保留、重启和加密恢复',
  { skip: !installed, timeout: 90000 },
  async (t) => {
    const dav = await mockCd2();
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'cloudreel-cd2-'));
    const root = path.join(fixture, 'files');
    await mkdir(root);
    let panel, server, base;
    const options = {
      HOST: '127.0.0.1',
      PANEL_PASSWORD: '',
      RCLONE_BIN: binary,
      DATA_DIR: path.join(fixture, 'panel'),
      LOCAL_ROOT: root,
      RCLONE_CONFIG: path.join(fixture, 'config/rclone.conf'),
      driveGroupOptions: {
        inspectMember: async (remote) => ({
          identity: remote,
          email: `${remote}@example.invalid`,
          teamDrive: 'team',
          rootId: 'team',
        }),
      },
    };
    const form = {
      name: '115-cd2',
      url: dav.url,
      rootPath: dav.rootPath,
      username: dav.username,
      password: dav.password,
    };
    async function start() {
      panel = await createPanel(options);
      assert.equal(panel.engine.ready, true, panel.engine.error);
      server = panel.app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      base = `http://127.0.0.1:${server.address().port}/api`;
    }
    async function close() {
      if (!panel) return;
      await panel.close();
      await new Promise((resolve) => server.close(resolve));
      panel = null;
    }
    t.after(async () => {
      await close();
      await dav.close();
      await rm(fixture, { recursive: true, force: true });
    });
    async function call(route, method = 'GET', body, expected = 200) {
      const response = await fetch(base + route, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      assert.equal(response.status, expected, `${route}: ${JSON.stringify(data)}`);
      return data;
    }
    async function until(route, desired = 'completed') {
      for (let i = 0; i < 1000; i++) {
        await panel.tick();
        const item = await call(route);
        if (item.status === desired) return item;
        if (['failed', 'blocked', 'waiting_quota', 'stopped', 'completed'].includes(item.status))
          assert.equal(item.status, desired, JSON.stringify(item));
        await wait();
      }
      assert.fail(`${route} timed out`);
    }
    await start();
    assert.ok((await call('/providers')).some((p) => p.name === 'cd2-webdav'));
    assert.equal((await call('/cd2/test', 'POST', form)).ok, true);
    assert.equal((await call('/remotes')).length, 0, '测试连接不创建配置');
    const added = await call('/cd2', 'POST', form);
    assert.equal(added.type, 'cd2-webdav');
    assert.equal(added.capabilities.upload, false);
    const list = await call('/remotes');
    assert.equal(list.length, 1);
    assert.equal(list[0].passwordConfigured, true);
    assert.equal(JSON.stringify(list).includes(dav.password), false);
    assert.equal(
      (await readFile(path.join(options.DATA_DIR, 'state.json'), 'utf8')).includes(dav.password),
      false,
    );
    assert.equal((await stat(options.RCLONE_CONFIG)).mode & 0o777, 0o600);
    assert.equal((await readFile(options.RCLONE_CONFIG, 'utf8')).includes(dav.password), false);
    await call('/cd2', 'POST', form, 409);
    await call(
      '/direct115',
      'POST',
      { name: form.name, cookie: 'UID=123_A1; CID=fake; SEID=fake' },
      409,
    );
    await call('/remotes/115-cd2', 'PUT', { parameters: { url: 'http://bad.invalid' } }, 400);
    assert.equal((await call('/files?remote=115-cd2')).items[0].Name, '动画');
    const sourceFiles = (await call('/files?remote=115-cd2&path=动画')).items;
    assert.equal(sourceFiles.length, 3);
    assert.ok(sourceFiles.some((item) => item.Name === '影片:特别篇.mkv'));
    await call('/files/mkdir', 'POST', { remote: '115-cd2', path: 'bad' }, 400);
    await call(
      '/jobs',
      'POST',
      {
        mode: 'copy',
        source: { remote: 'local', path: '' },
        destination: { remote: '115-cd2', path: '' },
      },
      400,
    );
    const saved = { ...form, password: '' };
    await call('/cd2/115-cd2', 'PUT', saved);
    assert.equal((await call('/cd2/115-cd2/test', 'POST', saved)).ok, true);
    await call('/cd2/115-cd2', 'PUT', { ...saved, username: 'another-user' }, 400);
    await call('/cd2/115-cd2/test', 'POST', { ...saved, rootPath: '' }, 400);
    for (const name of ['a', 'b'])
      await call('/remotes', 'POST', { name, type: 'local', parameters: { no_clone: 'true' } });
    await call('/drive-groups', 'POST', {
      name: 'google-group',
      members: [
        { remote: 'a', budgetBytes: 1 },
        { remote: 'b', budgetBytes: 1000 },
      ],
    });
    const input = {
      name: 'CD2 到 Google group',
      source: { remote: '115-cd2', path: '' },
      destination: { remote: 'google-group', path: 'cd2-target' },
      mode: 'copy',
      media: {
        enabled: true,
        preset: 'all',
        archive: 'preserve',
        rename: 'preserve',
        conflict: 'skip',
      },
    };
    const scan = await call('/media/scans', 'POST', input, 202);
    const scanned = await until(`/media/scans/${scan.id}`);
    assert.equal(scanned.result.totalFiles, 3);
    const job = await call('/jobs', 'POST', { ...input, scanId: scan.id });
    const ended = await until(`/jobs/${job.id}`);
    assert.equal(ended.targetRemote, 'b');
    assert.ok(ended.attempts >= 2);
    for (const [file, bytes] of dav.files)
      if (file.startsWith(`/dav/${dav.rootPath}/`)) {
        assert.deepEqual(
          await readFile(path.join(root, 'cd2-target', file.slice(`/dav/${dav.rootPath}/`.length))),
          bytes,
        );
      }
    assert.ok(ended.files.every((file) => file.status === 'completed'));
    assert.ok(dav.requests.some((r) => r.method === 'GET'));
    assert.ok(
      dav.requests.every((r) => ['PROPFIND', 'GET', 'HEAD'].includes(r.method)),
      'CD2 来源无写请求',
    );
    const pass = 'synthetic-backup-password',
      archive = await panel.backups.export(pass);
    assert.equal(JSON.stringify(archive).includes(dav.password), false);
    await close();
    await start();
    assert.equal((await call('/remotes')).find((r) => r.name === form.name).type, 'cd2-webdav');
    assert.equal((await call('/files?remote=115-cd2')).items[0].Name, '动画');
    await panel.backups.restore(archive, pass, true);
    assert.equal((await call('/remotes/115-cd2/test', 'POST', {})).ok, true);
    // Editing the root changes the live filesystem and invalidates an earlier scan binding.
    await call('/cd2/115-cd2', 'PUT', { ...saved, rootPath: '' });
    assert.ok((await call('/files?remote=115-cd2')).items.some((item) => item.Name === '另一网盘'));
    await call('/jobs', 'POST', { ...input, scanId: scan.id }, 409);
    dav.anonymous(true);
    await call('/cd2/115-cd2', 'PUT', { ...saved, rootPath: dav.rootPath, anonymous: true });
    const config = (await panel.engine.call('config/dump'))['115-cd2'];
    assert.equal(config.pass || '', '');
    assert.equal(config.user || '', '');
    assert.equal((await call('/cd2/115-cd2/test', 'POST', { ...saved, anonymous: true })).ok, true);
    assert.equal((await call('/files?remote=115-cd2')).items[0].Name, '动画');
    assert.equal(dav.requests.at(-1).authenticated, false);
    await call('/remotes/115-cd2', 'DELETE', {});
    assert.equal(
      JSON.parse(await readFile(path.join(options.DATA_DIR, 'state.json'), 'utf8')).cd2Remotes[
        '115-cd2'
      ],
      undefined,
    );
    assert.equal((await panel.engine.call('config/dump'))['115-cd2'], undefined);
  },
);
