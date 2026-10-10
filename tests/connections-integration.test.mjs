import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPanel } from '../server/app.mjs';

const binary = process.env.RCLONE_BIN || 'rclone';
const installed = spawnSync(binary, ['version']).status === 0;
test(
  '直接115真实rclone读取和复制、Google group切换、持久恢复及加密备份',
  { skip: !installed, timeout: 90000 },
  async (t) => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'cloudreel-connections-'));
    const root = path.join(fixture, 'files');
    await mkdir(path.join(root, 'src'), { recursive: true });
    const content = 'synthetic 115 bytes\n',
      ck = 'UID=123_A1; CID=synthetic-cid; SEID=synthetic-seid';
    await writeFile(path.join(root, 'src', 'group.txt'), content);
    let panel, server, base;
    const options = {
      HOST: '127.0.0.1',
      PANEL_PASSWORD: '',
      RCLONE_BIN: binary,
      DATA_DIR: path.join(fixture, 'panel'),
      LOCAL_ROOT: root,
      RCLONE_CONFIG: path.join(fixture, 'config/rclone.conf'),
      direct115Options: {
        clientFactory: () => ({
          list: async (id) =>
            id === '0'
              ? [{ id: '1', name: '目录', isDir: true, size: 0 }]
              : [
                  {
                    id: '2',
                    name: '电影 & 字幕.txt',
                    isDir: false,
                    size: Buffer.byteLength(content),
                    pickcode: 'pick123',
                    modified: new Date(0),
                  },
                ],
          download: async () =>
            new Response(content, {
              headers: { 'Content-Length': String(Buffer.byteLength(content)) },
            }),
        }),
      },
      driveGroupOptions: {
        inspectMember: async (remote) => ({
          identity: remote,
          email: `${remote}@example.invalid`,
          teamDrive: 'team',
          rootId: 'team',
        }),
      },
    };
    async function start() {
      panel = await createPanel(options);
      assert.equal(panel.engine.ready, true, panel.engine.error);
      server = panel.app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      base = `http://127.0.0.1:${server.address().port}/api`;
    }
    async function close() {
      await panel.close();
      await new Promise((resolve) => server.close(resolve));
      panel = null;
    }
    t.after(async () => {
      if (panel) await close();
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
    async function finish(id) {
      for (let i = 0; i < 200; i++) {
        await panel.tick();
        const task = (await call('/jobs')).find((job) => job.id === id);
        if (['completed', 'failed', 'blocked', 'waiting_quota'].includes(task.status)) {
          assert.equal(task.status, 'completed', JSON.stringify(task));
          return task;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('transfer timed out');
    }
    await start();
    await call('/direct115', 'POST', { name: '115-native', cookie: ck });
    const remotes = await call('/remotes');
    assert.equal(remotes[0].type, 'direct-115');
    assert.equal(JSON.stringify(remotes).includes('synthetic-cid'), false);
    assert.equal(
      (await call('/files?remote=115-native&path=目录')).items[0].Name,
      '电影 & 字幕.txt',
    );
    const directJob = await call('/jobs', 'POST', {
      source: { remote: '115-native', path: '目录' },
      destination: { remote: 'local', path: 'download' },
      mode: 'copy',
    });
    await finish(directJob.id);
    assert.equal(await readFile(path.join(root, 'download', '电影 & 字幕.txt'), 'utf8'), content);
    await call('/files/mkdir', 'POST', { remote: '115-native', path: 'bad' }, 400);
    await call(
      '/jobs',
      'POST',
      {
        source: { remote: 'local', path: 'src' },
        destination: { remote: '115-native', path: '' },
        mode: 'copy',
      },
      400,
    );
    for (const name of ['a', 'b'])
      await call('/remotes', 'POST', { name, type: 'local', parameters: {} });
    await call('/drive-groups', 'POST', {
      name: 'team-group',
      members: [
        { remote: 'a', budgetBytes: 1 },
        { remote: 'b', budgetBytes: 1000 },
      ],
    });
    await call('/remotes/a', 'DELETE', {}, 409);
    await call(
      '/jobs',
      'POST',
      {
        source: { remote: 'team-group', path: 'src' },
        destination: { remote: 'team-group', path: 'src' },
        mode: 'copy',
      },
      400,
    );
    const input = {
      source: { remote: '115-native', path: '目录' },
      destination: { remote: 'team-group', path: 'group-target' },
      mode: 'copy',
      media: { enabled: true },
    };
    const grouped = await call('/jobs', 'POST', input);
    const ended = await finish(grouped.id);
    assert.ok(ended.attempts >= 2);
    assert.equal(ended.targetRemote, 'b');
    assert.equal(ended.destination.remote, 'team-group');
    assert.equal(
      await readFile(path.join(root, 'group-target', '电影 & 字幕.txt'), 'utf8'),
      content,
    );
    const before = await call('/drive-groups');
    assert.ok(before[0].members[0].cooldownUntil);
    assert.ok(before[0].members[1].usedBytes > 0);
    const pass = 'synthetic-backup-password';
    const archive = await panel.backups.export(pass);
    assert.equal(JSON.stringify(archive).includes('synthetic-cid'), false);
    await close();
    await start();
    assert.deepEqual(await call('/drive-groups'), before);
    assert.equal(
      (await call('/files?remote=115-native&path=目录')).items[0].Name,
      '电影 & 字幕.txt',
    );
    await panel.backups.restore(archive, pass, true);
    const restoredGroups = await call('/drive-groups');
    assert.deepEqual(
      restoredGroups.map((group) => group.members.map(({ status, ...member }) => member)),
      before.map((group) => group.members.map(({ status, ...member }) => member)),
    );
    assert.equal(
      (await call('/files?remote=115-native&path=目录')).items[0].Name,
      '电影 & 字幕.txt',
    );
    await call('/direct115', 'POST', { name: 'team-group', cookie: ck }, 409);
  },
);
