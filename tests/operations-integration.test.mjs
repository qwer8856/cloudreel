import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createPanel } from '../server/app.mjs';
import { encryptBackup, decryptBackup } from '../server/backup.mjs';
import { failureKind, transferOptions, Operations } from '../server/operations.mjs';
import { mockOpenList } from './helpers/openlist.mjs';

const binary = process.env.RCLONE_BIN || 'rclone';
const installed = spawnSync(binary, ['version'], { windowsHide: true }).status === 0;
test('失败分类和筛选拒绝非法路径、选择同步和大小倒置', () => {
  assert.equal(failureKind('HTTP 429 Too many requests'), 'rate');
  assert.equal(failureKind('401 unauthorized'), 'auth');
  assert.equal(failureKind('500 connection reset'), 'network');
  assert.throws(() => transferOptions({ selections: [{ path: '../escape', isDir: false }] }));
  assert.throws(() =>
    transferOptions({ mode: 'sync', selections: [{ path: 'file', isDir: false }] }),
  );
  assert.throws(() => transferOptions({ filters: { minSize: 20, maxSize: 10 } }));
});
test('一个任务触及两个额度组时，耗尽较小额度不会冻结另一个账号的剩余额度', async () => {
  const state = {
    jobs: [],
    cloudRemotes: {},
    remotePolicies: { source: { groupId: 'small' }, target: { groupId: 'large' } },
    quotaGroups: [
      {
        id: 'small',
        name: '小额度',
        timezone: 'Asia/Shanghai',
        dailyBytes: 5,
        cutoffMode: 'soft',
        usage: {},
      },
      {
        id: 'large',
        name: '大额度',
        timezone: 'Asia/Shanghai',
        dailyBytes: 50,
        cutoffMode: 'soft',
        usage: {},
      },
    ],
  };
  const operations = new Operations({
    state,
    now: () => Date.parse('2026-10-06T12:00:00+08:00'),
    notify: async () => {},
  });
  const job = {
    id: 'test',
    source: { remote: 'source' },
    destination: { remote: 'target' },
    status: 'limited',
  };
  job.limits = operations.limits(job);
  operations.account(job, { bytes: 5 });
  await operations.finished(job, null, { success: false, error: 'max transfer limit reached' });
  assert.equal(state.quotaGroups[0].usage['2026-10-06'].outcome, 'bytes_limit');
  assert.equal(state.quotaGroups[1].usage['2026-10-06'].bytes, 5);
  assert.equal(state.quotaGroups[1].usage['2026-10-06'].outcome, 'waiting');
  assert.equal(
    operations.gate({
      id: 'another',
      source: { remote: 'target' },
      destination: { remote: 'unrelated' },
    }),
    null,
  );
});
test(
  '持久队列、账号额度、选择复制、重试、通知和备份',
  { skip: !installed, timeout: 120000 },
  async (t) => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'rclone-operations-'));
    const root = path.join(fixture, 'files');
    await mkdir(path.join(root, 'src', '子目录'), { recursive: true });
    await writeFile(path.join(root, 'src', '保留.txt'), 'a selected text\n');
    await writeFile(path.join(root, 'src', '忽略.tmp'), 'temporary\n');
    await writeFile(path.join(root, 'src', '子目录', '电影.mkv'), 'test movie\n');
    const mock = await mockOpenList();
    let panel,
      server,
      base,
      now = Date.parse('2026-10-06T02:00:00+08:00');
    const options = {
      HOST: '127.0.0.1',
      PANEL_PASSWORD: '',
      RCLONE_BIN: binary,
      LOCAL_ROOT: root,
      DATA_DIR: path.join(fixture, 'panel'),
      RCLONE_CONFIG: path.join(fixture, 'config/rclone.conf'),
      now: () => now,
    };
    async function start() {
      panel = await createPanel(options);
      assert.ok(panel.engine.ready, panel.engine.error);
      server = panel.app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      base = `http://127.0.0.1:${server.address().port}/api`;
    }
    async function close() {
      await panel.close();
      await new Promise((resolve) => server.close(resolve));
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
    const input = (source = 'src', destination = 'dst') => ({
      name: '中文互传',
      mode: 'copy',
      source: { remote: 'local', path: source },
      destination: { remote: 'local', path: destination },
    });
    async function finish(id, desired = 'completed') {
      for (let count = 0; count < 120; count++) {
        await panel.tick();
        const job = await call(`/jobs/${id}`);
        if (job.status === desired) return job;
        if (job.status === 'failed') assert.fail(job.error);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.fail(`任务未到达 ${desired}: ${JSON.stringify(await call(`/jobs/${id}`))}`);
    }
    try {
      await start();
      await t.test('真实 rclone 勾选目录与排除规则取交集，只复制选中文件', async () => {
        const job = await call('/jobs', 'POST', {
          ...input(),
          selections: [
            { path: '子目录', isDir: true },
            { path: '忽略.tmp', isDir: false },
          ],
          filters: { exclude: ['*.tmp'] },
        });
        await finish(job.id);
        assert.deepEqual(await readdir(path.join(root, 'dst')), ['子目录']);
        assert.equal(
          await readFile(path.join(root, 'dst', '子目录', '电影.mkv'), 'utf8'),
          'test movie\n',
        );
      });
      await t.test('文件类型与大小筛选在真实复制中生效', async () => {
        const job = await call('/jobs', 'POST', {
          ...input('src', 'filter-target'),
          filters: { include: ['*.txt'], minSize: 5, maxSize: 100 },
        });
        await finish(job.id);
        assert.deepEqual(await readdir(path.join(root, 'filter-target')), ['保留.txt']);
      });
      await t.test('文件明细、CSV 和共同哈希校验可查询', async () => {
        const job = await call('/jobs', 'POST', { ...input('src', 'details-target') });
        const finished = await finish(job.id);
        assert.ok(
          finished.files.some((file) => file.path === '保留.txt' && file.status === 'completed'),
          JSON.stringify(finished.files),
        );
        const csv = await fetch(base + `/jobs/${job.id}/export`);
        assert.ok((await csv.text()).includes('保留.txt'));
        await call(`/jobs/${job.id}/verify`, 'POST', { mode: 'hash' });
        for (let i = 0; i < 50; i++) {
          await panel.tick();
          const detail = await call(`/jobs/${job.id}`);
          if (detail.verification.status !== 'running') {
            assert.equal(
              detail.verification.status,
              'completed',
              JSON.stringify(detail.verification),
            );
            assert.ok(detail.verification.report.hashType);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      });
      await t.test('超过每日额度的大文件在预检查中被识别', async () => {
        const analysis = await call('/transfers/analyze', 'POST', { ...input(), dailyBytes: 5 });
        assert.equal(analysis.count, 3);
        assert.ok(analysis.oversizedCount);
        assert.ok(analysis.warning);
      });
      await t.test('普通任务和排队任务重启后自动恢复，手动暂停仍保持暂停', async () => {
        await mkdir(path.join(root, 'slow'), { recursive: true });
        await writeFile(path.join(root, 'slow', 'large.bin'), Buffer.alloc(2 * 1024 ** 2, 7));
        await call('/operations', 'PUT', { ...(await call('/operations')).settings, maxJobs: 1 });
        await call('/settings', 'PUT', { transfers: 1, checkers: 2, retries: 1, bandwidth: '32K' });
        const first = await call('/jobs', 'POST', input('slow', 'slow-target'));
        const second = await call('/jobs', 'POST', input('src', 'queued-target'));
        assert.equal(first.status, 'running');
        assert.equal(second.status, 'queued');
        await close();
        await start();
        await call('/settings', 'PUT', { transfers: 1, checkers: 2, retries: 1, bandwidth: '' });
        await finish(first.id);
        await finish(second.id);
        assert.ok((await call(`/jobs/${first.id}`)).attempts >= 2);
        await call('/settings', 'PUT', { transfers: 1, checkers: 2, retries: 1, bandwidth: '32K' });
        const paused = await call('/jobs', 'POST', input('slow', 'paused-target'));
        await call(`/jobs/${paused.id}/pause`, 'POST', {});
        await finish(paused.id, 'paused');
        await close();
        await start();
        await panel.tick();
        assert.equal((await call(`/jobs/${paused.id}`)).status, 'paused');
        await call('/settings', 'PUT', { transfers: 1, checkers: 2, retries: 1, bandwidth: '' });
        await call(`/jobs/${paused.id}/resume`, 'POST', {});
        await finish(paused.id);
      });
      await t.test('关闭自动恢复后，运行和排队任务重启都保持暂停', async () => {
        await call('/settings', 'PUT', { transfers: 1, checkers: 2, retries: 1, bandwidth: '32K' });
        const first = await call('/jobs', 'POST', input('slow', 'manual-restart-first'));
        const second = await call('/jobs', 'POST', input('src', 'manual-restart-second'));
        await call('/operations', 'PUT', {
          ...(await call('/operations')).settings,
          autoResume: false,
        });
        await close();
        await start();
        await panel.tick();
        assert.equal((await call(`/jobs/${first.id}`)).status, 'paused');
        assert.equal((await call(`/jobs/${second.id}`)).status, 'paused');
        await call('/operations', 'PUT', {
          ...(await call('/operations')).settings,
          autoResume: true,
        });
        await call('/settings', 'PUT', { transfers: 1, checkers: 2, retries: 1, bandwidth: '' });
        await call(`/jobs/${first.id}/resume`, 'POST', {});
        await call(`/jobs/${second.id}/resume`, 'POST', {});
        await finish(first.id);
        await finish(second.id);
      });
      await t.test('rclone 子进程异常退出后自动重启并继续任务', async () => {
        await call('/settings', 'PUT', { transfers: 1, checkers: 2, retries: 1, bandwidth: '32K' });
        const job = await call('/jobs', 'POST', input('slow', 'engine-restart-target'));
        const child = panel.engine.child;
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill();
        await exited;
        assert.equal(panel.engine.ready, false);
        await panel.tick();
        assert.equal(panel.engine.ready, true, panel.engine.error);
        await call('/settings', 'PUT', { transfers: 1, checkers: 2, retries: 1, bandwidth: '' });
        await finish(job.id);
        assert.ok((await call(`/jobs/${job.id}`)).attempts >= 2);
      });
      await t.test('共享额度串行保留累计量，次日继续，账号配置隔离', async () => {
        await mkdir(path.join(root, 'quota-src'), { recursive: true });
        for (const name of ['a', 'b', 'c'])
          await writeFile(path.join(root, 'quota-src', name), Buffer.alloc(40 * 1024, 3));
        const group = await call('/quota-groups', 'POST', {
          name: '每日共享额度',
          dailyBytes: 70 * 1024,
          timezone: 'Asia/Shanghai',
          cutoffMode: 'soft',
        });
        await call('/accounts/local', 'PUT', {
          label: '本地额度测试账号',
          maxJobs: 2,
          groupId: group.id,
        });
        try {
          const first = await call('/jobs', 'POST', input('quota-src', 'quota-target'));
          const second = await call('/jobs', 'POST', input('src', 'quota-second'));
          // The first copy can exhaust its budget before the second request arrives.
          assert.ok(['queued', 'waiting_quota'].includes(second.status), JSON.stringify(second));
          assert.equal(second.attempts, 0);
          await finish(first.id, 'waiting_quota');
          assert.equal((await call('/operations')).groups[0].today.bytes, 80 * 1024);
          assert.equal((await call(`/jobs/${second.id}`)).status, 'waiting_quota');
          now += 86400000;
          await finish(first.id);
          await finish(second.id);
          assert.equal((await readdir(path.join(root, 'quota-target'))).length, 3);
          assert.ok((await call('/operations')).groups[0].today.bytes < 70 * 1024);
        } finally {
          await call('/accounts/local', 'PUT', { label: '本地', maxJobs: 2, groupId: '' });
        }
      });
      await t.test('同一种网盘的两个账号拥有不同挂载和凭据，删除不会影响另一账号', async () => {
        await call('/openlist', 'PUT', {
          url: mock.url,
          username: 'admin',
          password: 'synthetic-admin-password',
        });
        for (const name of ['115-main', '115-second'])
          await call('/cloud-remotes', 'POST', {
            name,
            type: 'openlist-115',
            mode: 'cookie',
            parameters: { cookie: `synthetic-cookie-${name}` },
          });
        const state = JSON.parse(await readFile(path.join(fixture, 'panel/state.json'), 'utf8'));
        assert.notEqual(
          state.cloudRemotes['115-main'].mountPath,
          state.cloudRemotes['115-second'].mountPath,
        );
        assert.notEqual(
          state.cloudRemotes['115-main'].storageId,
          state.cloudRemotes['115-second'].storageId,
        );
        const list = await call('/remotes');
        assert.equal(list.filter((remote) => remote.type === 'openlist-115').length, 2);
        assert.ok(!JSON.stringify(list).includes('synthetic-cookie'));
        await call('/accounts/115-main', 'PUT', { label: '115 主账号', maxJobs: 1, groupId: '' });
        assert.equal(
          (await call('/remotes')).find((remote) => remote.name === '115-main').accountLabel,
          '115 主账号',
        );
        await call('/remotes/115-second', 'DELETE', {});
        assert.equal((await call('/cloud-remotes/115-main')).phase, 'ready');
      });
      await t.test('限流按退避重试，永久失败只重试已记录失败文件', async () => {
        const original = panel.engine.call.bind(panel.engine);
        let executions = 0;
        panel.engine.call = async (endpoint, args) => {
          if (endpoint === 'sync/copy') {
            executions++;
            return { jobid: 90000 + executions };
          }
          if (endpoint === 'job/status' && args.jobid >= 90000)
            return {
              finished: true,
              success: executions > 1,
              error: executions === 1 ? '429 Too many requests' : '',
              endTime: new Date().toISOString(),
            };
          if (endpoint === 'core/stats' && args.group?.startsWith('studio/')) return { bytes: 10 };
          if (endpoint === 'core/transferred') return { transferred: [] };
          return original(endpoint, args);
        };
        const job = await call('/jobs', 'POST', input('src', 'retry-target'));
        await panel.tick();
        const waiting = await call(`/jobs/${job.id}`);
        assert.equal(waiting.status, 'retry_wait');
        assert.equal(executions, 1);
        now = waiting.retryAt + 1;
        await panel.tick();
        await panel.tick();
        assert.equal((await call(`/jobs/${job.id}`)).status, 'completed');
        assert.equal(executions, 2);
        panel.engine.call = async (endpoint, args) => {
          if (endpoint === 'sync/copy') return { jobid: 91000 };
          if (endpoint === 'job/status' && args.jobid === 91000)
            return {
              finished: true,
              success: false,
              error: 'destination disk full',
              endTime: new Date().toISOString(),
            };
          if (endpoint === 'core/stats' && args.group?.startsWith('studio/')) return { bytes: 0 };
          if (endpoint === 'core/transferred')
            return {
              transferred: [
                {
                  name: '子目录/电影.mkv',
                  size: 11,
                  bytes: 0,
                  what: 'transferring',
                  error: 'disk full',
                  timestamp: Date.now(),
                },
              ],
            };
          return original(endpoint, args);
        };
        const failed = await call('/jobs', 'POST', input('src', 'failed-target'));
        await panel.tick();
        assert.equal((await call(`/jobs/${failed.id}`)).status, 'failed');
        panel.engine.call = original;
        const retry = await call(`/jobs/${failed.id}/retry-files`, 'POST', {});
        await finish(retry.id);
        assert.deepEqual(await readdir(path.join(root, 'failed-target')), ['子目录']);
      });
      await t.test('授权失效阻止同账号队列，健康检查成功后恢复', async () => {
        await call('/remotes', 'POST', { name: 'native', type: 'local', parameters: {} });
        const original = panel.engine.call.bind(panel.engine);
        panel.engine.call = async (endpoint, args) => {
          if (endpoint === 'sync/copy') return { jobid: 92000 };
          if (endpoint === 'job/status' && args.jobid === 92000)
            return {
              finished: true,
              success: false,
              error: '401 unauthorized',
              endTime: new Date().toISOString(),
            };
          if (endpoint === 'core/stats' && args.group?.startsWith('studio/')) return { bytes: 0 };
          if (endpoint === 'core/transferred') return { transferred: [] };
          return original(endpoint, args);
        };
        const job = await call('/jobs', 'POST', {
          ...input('src', 'auth-target'),
          source: { remote: 'native', path: 'src' },
        });
        await panel.tick();
        assert.equal((await call(`/jobs/${job.id}`)).status, 'blocked');
        panel.engine.call = original;
        assert.equal((await call('/accounts/native/check', 'POST', {})).status, 'healthy');
        await finish(job.id);
      });
      await t.test('Webhook 设置不回填秘密，失败会等待重试，成功通知有记录', async () => {
        let calls = 0,
          received;
        const hook = http.createServer((request, response) => {
          let body = '';
          request.on('data', (data) => {
            body += data;
          });
          request.on('end', () => {
            calls++;
            received = JSON.parse(body);
            response.writeHead(calls === 1 ? 503 : 200);
            response.end('{}');
          });
        });
        hook.listen(0, '127.0.0.1');
        await new Promise((resolve) => hook.once('listening', resolve));
        try {
          const view = await call('/notifications', 'PUT', {
            enabled: true,
            channel: 'webhook',
            url: `http://127.0.0.1:${hook.address().port}/synthetic`,
            events: ['completed'],
            chatId: '',
          });
          assert.ok(view.urlSaved);
          assert.equal(view.url, undefined);
          await panel.notifications.enqueue('completed', {
            id: 'synthetic',
            name: '测试通知',
            transferredBytes: 20,
          });
          await panel.notifications.tick();
          assert.equal((await call('/notifications')).pending, 1);
          now += 60001;
          await panel.notifications.tick();
          assert.equal((await call('/notifications')).pending, 0);
          assert.equal(received.event, 'completed');
          assert.equal((await call('/notifications')).history[0].status, 'sent');
          await call('/notifications', 'PUT', {
            enabled: false,
            channel: 'webhook',
            url: '',
            events: ['completed'],
            chatId: '',
          });
        } finally {
          await new Promise((resolve) => hook.close(resolve));
        }
      });
      await t.test(
        '加密完整备份包含网盘授权，错误密码和损坏文件被拒绝，恢复前有恢复点',
        async () => {
          const passphrase = 'synthetic-backup-password';
          const archive = await call('/backups/export', 'POST', { passphrase });
          assert.ok(!JSON.stringify(archive).includes('synthetic-cookie'));
          const info = await call('/backups/inspect', 'POST', { archive, passphrase });
          assert.equal(info.cloudAccounts, 1);
          await call(
            '/backups/inspect',
            'POST',
            { archive, passphrase: 'wrong-synthetic-password' },
            400,
          );
          const tampered = { ...archive, tag: Buffer.alloc(16).toString('base64') };
          await call('/backups/inspect', 'POST', { archive: tampered, passphrase }, 400);
          await call('/operations', 'PUT', { ...(await call('/operations')).settings, maxJobs: 7 });
          await call(
            '/backups/restore',
            'POST',
            { archive, passphrase, confirmRestore: false },
            400,
          );
          const restored = await call('/backups/restore', 'POST', {
            archive,
            passphrase,
            confirmRestore: true,
          });
          assert.ok(restored.paused);
          assert.equal((await call('/operations')).settings.maxJobs, 1);
          assert.equal((await call('/cloud-remotes/115-main')).phase, 'ready');
          assert.ok((await readdir(path.join(fixture, 'panel/full-backups'))).length);
          assert.equal(
            await readFile(path.join(root, 'details-target', '保留.txt'), 'utf8'),
            'a selected text\n',
          );
          assert.equal((await call('/notifications')).enabled, false);
        },
      );
      await t.test('恢复时的周期检测不会重复启动 rclone', async () => {
        const passphrase = 'synthetic-race-backup-password';
        const archive = await call('/backups/export', 'POST', { passphrase });
        const originalStop = panel.engine.stop.bind(panel.engine),
          originalStart = panel.engine.start.bind(panel.engine);
        let starts = 0;
        const pendingTicks = [];
        panel.engine.stop = async () => {
          await originalStop();
          pendingTicks.push(panel.tick());
        };
        panel.engine.start = async () => {
          starts++;
          await originalStart();
        };
        try {
          await call('/backups/restore', 'POST', { archive, passphrase, confirmRestore: true });
          await Promise.all(pendingTicks);
          assert.equal(starts, 1);
          assert.ok(panel.engine.ready);
          assert.ok(await panel.engine.call('core/version'));
        } finally {
          panel.engine.stop = originalStop;
          panel.engine.start = originalStart;
        }
      });
      await t.test('恢复待验证短信不会重发消息，失效授权保留配置供修复', async () => {
        await call('/cloud-remotes', 'POST', {
          name: 'pending-sms',
          type: 'openlist-guangya',
          mode: 'sms',
          action: 'send-code',
          parameters: { client_id: 'synthetic-client', phone_number: '13800000000' },
        });
        const payload = await panel.backups.snapshot();
        const storage = payload.storages.find((storage) => storage.name === 'pending-sms');
        storage.mount.addition = JSON.stringify({
          ...JSON.parse(storage.mount.addition),
          send_code: true,
          verify_code: 'synthetic-old-code',
        });
        const passphrase = 'synthetic-pending-backup-password';
        const archive = await encryptBackup(payload, passphrase);
        const before = mock.requests.length;
        mock.fail(true);
        try {
          await call('/backups/restore', 'POST', { archive, passphrase, confirmRestore: true });
          const smsWrites = mock.requests
            .slice(before)
            .filter(
              (request) =>
                request.path === '/api/admin/storage/update' &&
                request.body.driver === 'GuangYaPan',
            );
          assert.ok(smsWrites.length);
          for (const request of smsWrites) {
            const addition = JSON.parse(request.body.addition);
            assert.equal(addition.send_code, false);
            assert.equal(addition.verify_code, '');
          }
          assert.equal((await call('/cloud-remotes/115-main')).phase, 'error');
        } finally {
          mock.fail(false);
        }
        await call('/cloud-remotes/115-main', 'PUT', { parameters: {} });
        assert.equal((await call('/cloud-remotes/115-main')).phase, 'ready');
        await call('/remotes/pending-sms', 'DELETE', {});
      });
      await t.test('恢复前验证结构，不接受挂载越界和运行中的备份', async () => {
        const passphrase = 'synthetic-backup-password';
        const payload = await panel.backups.snapshot();
        payload.storages[0].mount.mount_path = '/other-owned-path';
        const archive = await encryptBackup(payload, passphrase);
        await assert.rejects(() => decryptBackup(archive, passphrase), /挂载记录无效/);
        const job = await call('/jobs', 'POST', input('slow', 'busy-target'));
        await call('/backups/export', 'POST', { passphrase }, 409);
        await finish(job.id);
      });
    } finally {
      if (panel) await close();
      await mock.close();
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
