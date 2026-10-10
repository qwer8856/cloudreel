import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPanel } from '../server/app.mjs';

const binary = process.env.RCLONE_BIN || 'rclone';
const installed = spawnSync(binary, ['version']).status === 0;
const wait = () => new Promise((resolve) => setTimeout(resolve, 10));

test(
  '真实 rclone 后台目录扫描、取消、结果持久化及完整清单复用',
  { skip: !installed, timeout: 120000 },
  async (t) => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'cloudreel-scans-'));
    const root = path.join(fixture, 'files');
    await mkdir(root);
    let panel, server, base;
    let clock = Date.now();
    const options = {
      HOST: '127.0.0.1',
      PANEL_PASSWORD: '',
      RCLONE_BIN: binary,
      LOCAL_ROOT: root,
      DATA_DIR: path.join(fixture, 'panel'),
      RCLONE_CONFIG: path.join(fixture, 'config/rclone.conf'),
      now: () => clock,
    };
    async function start() {
      panel = await createPanel(options);
      assert.equal(panel.engine.ready, true, panel.engine.error);
      server = await new Promise((resolve) => {
        const s = panel.app.listen(0, '127.0.0.1', () => resolve(s));
      });
      base = `http://127.0.0.1:${server.address().port}/api`;
    }
    async function close() {
      if (!panel) return;
      await panel.close();
      await new Promise((resolve) => server.close(resolve));
      panel = server = undefined;
    }
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
    async function put(file, content = 'fixture video') {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
    const input = (source, destination, extra = {}) => ({
      name: '后台扫描验收',
      mode: 'copy',
      source: { remote: 'scan_source', path: source },
      destination: { remote: 'scan_target', path: destination },
      media: {
        enabled: true,
        preset: 'all',
        archive: 'preserve',
        rename: 'preserve',
        conflict: 'skip',
      },
      renameConfirmed: true,
      ...extra,
    });
    async function complete(id, desired = 'completed') {
      for (let i = 0; i < 1000; i++) {
        const scan = await call(`/media/scans/${id}`);
        if (!['queued', 'running', 'cancelling'].includes(scan.status)) {
          assert.equal(scan.status, desired, JSON.stringify(scan));
          return scan;
        }
        await wait();
      }
      assert.fail('扫描超时');
    }
    async function finish(id, desired = 'completed') {
      for (let i = 0; i < 1500; i++) {
        await panel.tick();
        const job = await call(`/jobs/${id}`);
        if (job.status === desired) return job;
        if (['completed', 'failed', 'limited', 'blocked', 'stopped'].includes(job.status)) {
          assert.equal(job.status, desired, JSON.stringify(job));
          return job;
        }
        await wait();
      }
      assert.fail('传输超时');
    }
    let request, snapshot;
    try {
      await start();
      for (const name of ['scan_source', 'scan_target'])
        await call('/remotes', 'POST', { name, type: 'local', parameters: { no_clone: 'true' } });

      await t.test('按目录分批读取，筛选等价于递归扫描，只检查涉及的目标目录', async () => {
        await put('source/电影/动画/片.mkv');
        await put('source/电影/动画/片.srt', '字幕');
        await put('source/电影/skip/忽略.mkv');
        await put('source/电影/动画/小.mkv', 'x');
        await put('source/其它/readme.txt');
        await put('target/电影/动画/片.mkv');
        await put('target/unrelated/deep/无关.mkv');
        const r = input('source', 'target', {
          filters: { include: ['电影/动画/**'], exclude: ['电影/skip/**'], minSize: 2 },
        });
        const recursive = await call('/media/preview', 'POST', r);
        const calls = [];
        const original = panel.engine.call.bind(panel.engine);
        panel.engine.call = async (endpoint, args, ...rest) => {
          if (endpoint === 'operations/list') calls.push(args);
          return original(endpoint, args, ...rest);
        };
        const created = await call('/media/scans', 'POST', r, 202);
        const scanned = await complete(created.id);
        panel.engine.call = original;
        assert.deepEqual(
          scanned.result.files.map((f) => [f.path, f.action]).sort(),
          recursive.files.map((f) => [f.path, f.action]).sort(),
        );
        assert.equal(scanned.result.totalFiles, 2);
        assert.ok(calls.every((c) => c.opt.recurse === false));
        assert.ok(!calls.some((c) => /unrelated/.test(c.remote)));
        const targets = calls.filter((c) => c.fs.endsWith('/target'));
        assert.deepEqual(
          targets.map((c) => c.remote),
          ['电影/动画'],
        );
        assert.ok(scanned.progress.directoriesDone >= 3);
        assert.equal(scanned.result.skippedExisting, 1);
        assert.equal((await call('/jobs')).length, 0);
        await call(
          '/jobs',
          'POST',
          { ...r, scanId: scanned.id, destination: { ...r.destination, path: 'other' } },
          409,
        );
        await call('/jobs', 'POST', { ...r, scanId: scanned.id, filters: {} }, 409);
        assert.equal((await call('/jobs')).length, 0);
      });

      await t.test('超过 200 项仍保存完整清单，重启后可确认，传输不再枚举来源', async () => {
        for (let i = 0; i < 205; i++) await put(`many/电影-${i}.mkv`, `video ${i}`);
        request = input('many', 'many-target');
        snapshot = await complete((await call('/media/scans', 'POST', request, 202)).id);
        assert.equal(snapshot.result.totalFiles, 205);
        assert.equal(snapshot.result.files.length, 200);
        assert.equal(snapshot.result.truncated, true);
        await close();
        await start();
        assert.equal((await call(`/media/scans/${snapshot.id}`)).status, 'completed');
        await put('many/扫描后新增.mkv');
        const original = panel.engine.call.bind(panel.engine);
        let lists = 0;
        panel.engine.call = async (endpoint, ...args) => {
          if (endpoint === 'operations/list') lists++;
          return original(endpoint, ...args);
        };
        const analyzed = await call('/transfers/analyze', 'POST', {
          ...request,
          scanId: snapshot.id,
          dailyBytes: 1,
        });
        assert.equal(analyzed.oversizedCount, 205);
        const job = await call('/jobs', 'POST', { ...request, scanId: snapshot.id });
        assert.equal(job.files.length, 205);
        const ended = await finish(job.id);
        assert.equal(ended.files.filter((f) => f.status === 'completed').length, 205);
        assert.equal(lists, 0);
        assert.equal((await readdir(path.join(root, 'many-target'))).length, 205);
        assert.equal(
          await readFile(path.join(root, 'many-target/电影-204.mkv'), 'utf8'),
          'video 204',
        );
        panel.engine.call = original;
      });

      await t.test('部分文件选择和多个来源目录保留原有筛选与归档语义', async () => {
        const selected = input('source', 'selected-target', {
          selections: [{ path: '电影/动画/片.mkv', isDir: false }],
          filters: { exclude: ['**/*.srt'] },
        });
        const selection = await complete((await call('/media/scans', 'POST', selected, 202)).id);
        assert.deepEqual(
          selection.result.files.map((f) => f.sourceFile),
          ['电影/动画/片.mkv'],
        );
        await put('second/另一个.mkv');
        const multiple = input('source', 'multi-target', {
          sourcePaths: ['source/电影/动画', 'second'],
          filters: { exclude: ['*.srt'], minSize: 2 },
        });
        const recursive = await call('/media/preview', 'POST', multiple);
        const scan = await complete((await call('/media/scans', 'POST', multiple, 202)).id);
        assert.deepEqual(
          scan.result.files.map((f) => f.targetFile).sort(),
          recursive.files.map((f) => f.targetFile).sort(),
        );
        assert.equal(scan.result.totalFiles, 2);
      });

      await t.test('复制前重新检查目标，来源大小变化使任务失败且不复制', async () => {
        await put('changed/片.mkv', 'old');
        const r = input('changed', 'changed-target');
        const scan = await complete((await call('/media/scans', 'POST', r, 202)).id);
        await put('changed/片.mkv', 'new larger contents');
        const failed = await finish(
          (await call('/jobs', 'POST', { ...r, scanId: scan.id })).id,
          'failed',
        );
        assert.match(failed.error, /来源文件/);
        await put('protected/片.mkv', 'source');
        const p = input('protected', 'protected-target');
        const protectedScan = await complete((await call('/media/scans', 'POST', p, 202)).id);
        await put('protected-target/片.mkv', 'preserve existing target');
        const ended = await finish(
          (await call('/jobs', 'POST', { ...p, scanId: protectedScan.id })).id,
        );
        assert.equal(ended.files[0].status, 'skipped');
        assert.equal(
          await readFile(path.join(root, 'protected-target/片.mkv'), 'utf8'),
          'preserve existing target',
        );
      });

      await t.test('取消真实 WebDAV 请求；扫描和任务准备均不阻塞控制接口', async () => {
        let seen = 0,
          closed = 0;
        const slow = createServer((req, res) => {
          if (req.method === 'PROPFIND') {
            seen++;
            res.on('close', () => closed++);
          } else res.end();
        });
        await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
        try {
          await call('/remotes', 'POST', {
            name: 'scan_slow',
            type: 'webdav',
            parameters: { url: `http://127.0.0.1:${slow.address().port}/`, vendor: 'other' },
          });
          const r = { ...input('', 'slow-target'), source: { remote: 'scan_slow', path: '' } };
          const scan = await call('/media/scans', 'POST', r, 202);
          for (let i = 0; i < 300 && !seen; i++) await wait();
          assert.ok(seen);
          await call('/remotes/scan_slow', 'DELETE', {}, 409);
          await call(`/media/scans/${scan.id}`, 'DELETE', {});
          await complete(scan.id, 'cancelled');
          for (let i = 0; i < 300 && !closed; i++) await wait();
          assert.equal(closed, seen, '取消必须传播到真实 rclone WebDAV 请求');
          await call('/jobs', 'POST', { ...r, scanId: scan.id }, 409);
          const job = await call('/jobs', 'POST', r);
          assert.equal(job.mediaPreparing, true);
          await call('/jobs');
          await call(`/jobs/${job.id}/stop`, 'POST', {});
          await finish(job.id, 'stopped');
          const interrupted = await call('/media/scans', 'POST', r, 202);
          const other = await call('/media/scans', 'POST', r, 202);
          await call('/media/scans', 'POST', r, 429);
          await close();
          await start();
          assert.equal((await call(`/media/scans/${interrupted.id}`)).status, 'interrupted');
          assert.equal((await call(`/media/scans/${other.id}`)).status, 'interrupted');
          assert.equal((await call('/jobs')).find((j) => j.id === job.id).status, 'stopped');
        } finally {
          slow.closeAllConnections();
          await new Promise((resolve) => slow.close(resolve));
        }
      });

      await t.test('修改连接和过期结果不能复用，客户端不能注入文件清单', async () => {
        request = input('protected', 'binding-target');
        snapshot = await complete((await call('/media/scans', 'POST', request, 202)).id);
        const paused = await call('/jobs', 'POST', { ...request, scanId: snapshot.id });
        await call(`/jobs/${paused.id}/pause`, 'POST', {});
        await finish(paused.id, 'paused');
        await call('/remotes/scan_target', 'PUT', { parameters: { no_clone: 'false' } });
        await call('/jobs', 'POST', { ...request, scanId: snapshot.id }, 409);
        const resumed = await call(`/jobs/${paused.id}/resume`, 'POST', {});
        assert.equal(resumed.status, 'failed');
        assert.match(resumed.error, /存储连接已变更/);
        const r = input('protected', 'injection-target');
        const job = await call('/jobs', 'POST', {
          ...r,
          mediaPlan: { files: [], totalFiles: 0, totalBytes: 0 },
        });
        const ended = await finish(job.id);
        assert.equal(ended.files.length, 1);
        clock += 3600001;
        await call(`/media/scans/${snapshot.id}`, 'GET', undefined, 410);
      });
    } finally {
      await close();
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
