import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPanel } from '../server/app.mjs';
import { Client115 } from '../server/direct115.mjs';

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

test(
  '直接115特殊名称经真实rclone浏览、递归复制，转义字面名称不会串文件',
  { skip: !installed, timeout: 60000 },
  async (t) => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'cloudreel-115-names-'));
    const root = path.join(fixture, 'files');
    const names = [
      ['Re:Zero.txt', 'Re%3AZero.txt'],
      ['Re%3AZero.txt', 'Re%253AZero.txt'],
      ['a\\b.txt', 'a%5Cb.txt'],
      ['a%5Cb.txt', 'a%255Cb.txt'],
      ['line\n.txt', 'line%0A.txt'],
      ['动画 & <字幕> 😀.txt', '动画 & <字幕> 😀.txt'],
      ['100%.txt', '100%25.txt'],
      ['.', '%2E'],
      ['..', '%2E%2E'],
      ['%2E', '%252E'],
    ];
    const contents = new Map();
    const entries = names.map(([n], i) => {
      const pc = `pick${i + 100}`,
        content = `unique file ${i}: ${n}\n`;
      contents.set(pc, content);
      return { fid: String(i + 100), n, s: Buffer.byteLength(content), pc, t: '1' };
    });
    contents.set('pick300', 'nested slash file\n');
    const directories = {
      0: [{ cid: '1', n: '电影' }],
      1: [
        { cid: '2', n: '动画电影' },
        { cid: '3', n: '电影/动画电影' },
      ],
      2: [...entries, { cid: '20', n: 'Season:01' }],
      3: [],
      20: [{ fid: '300', n: 'part/one.txt', s: 18, pc: 'pick300', t: '1' }],
    };
    const panel = await createPanel({
      HOST: '127.0.0.1',
      PANEL_PASSWORD: '',
      RCLONE_BIN: binary,
      DATA_DIR: path.join(fixture, 'panel'),
      LOCAL_ROOT: root,
      RCLONE_CONFIG: path.join(fixture, 'config/rclone.conf'),
      direct115Options: {
        clientFactory: (cookie) => {
          const client = new Client115(cookie, async (url) => {
            const { searchParams } = new URL(url),
              cid = searchParams.get('cid'),
              data = directories[cid];
            assert.ok(data, `unexpected directory ${cid}`);
            return Response.json({ state: true, cid, count: data.length, offset: 0, data });
          });
          client.download = async (pickcode) => {
            assert.ok(contents.has(pickcode), `unexpected pickcode ${pickcode}`);
            const content = contents.get(pickcode);
            return new Response(content, {
              headers: { 'Content-Length': String(Buffer.byteLength(content)) },
            });
          };
          return client;
        },
      },
    });
    const server = panel.app.listen(0, '127.0.0.1');
    t.after(async () => {
      await panel.close();
      await new Promise((resolve) => server.close(resolve));
      await rm(fixture, { recursive: true, force: true });
    });
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    async function call(route, body) {
      const response = await fetch(base + route, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json();
      assert.equal(response.status, 200, `${route}: ${JSON.stringify(data)}`);
      return data;
    }
    await call('/direct115', {
      name: '115-native',
      cookie: 'UID=123_A1; CID=synthetic-cid; SEID=synthetic-seid',
    });
    async function list(relative) {
      return (await call(`/files?remote=115-native&path=${encodeURIComponent(relative)}`)).items;
    }
    assert.deepEqual(
      (await list('电影')).map((item) => item.Name).sort(),
      ['动画电影', '电影%2F动画电影'].sort(),
    );
    assert.deepEqual(await list('电影/电影%2F动画电影'), []);
    assert.deepEqual(
      (await list('电影/动画电影')).map((item) => item.Name).sort(),
      [...names.map(([, alias]) => alias), 'Season%3A01'].sort(),
    );
    assert.equal((await list('电影/动画电影/Season%3A01'))[0].Name, 'part%2Fone.txt');
    const created = await call('/jobs', {
      source: { remote: '115-native', path: '电影/动画电影' },
      destination: { remote: 'local', path: 'download' },
      mode: 'copy',
    });
    let completed;
    for (let i = 0; i < 200; i++) {
      await panel.tick();
      const job = (await call('/jobs')).find((item) => item.id === created.id);
      if (['completed', 'failed', 'blocked', 'waiting_quota'].includes(job.status)) {
        assert.equal(job.status, 'completed', JSON.stringify(job));
        completed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(completed, 'recursive transfer completed');
    for (const [i, [, alias]] of names.entries())
      assert.equal(
        await readFile(path.join(root, 'download', alias), 'utf8'),
        contents.get(`pick${i + 100}`),
      );
    assert.equal(
      await readFile(path.join(root, 'download', 'Season%3A01', 'part%2Fone.txt'), 'utf8'),
      contents.get('pick300'),
    );
  },
);
