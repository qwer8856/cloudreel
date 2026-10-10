import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPanel } from '../server/app.mjs';

const binary = process.env.RCLONE_BIN || 'rclone';
const installed = spawnSync(binary, ['version'], { windowsHide: true }).status === 0;

test(
  '真实 rclone 影视归档、增量、失败重试、暂停恢复和每日预算',
  { skip: !installed, timeout: 120000 },
  async (t) => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'rclone-media-integration-'));
    const root = path.join(fixture, 'files');
    await mkdir(root, { recursive: true });
    let panel, server, base;
    // Advancing six minutes must stay on the same quota day, even when tests run near midnight.
    let clock = new Date('2026-10-10T12:00:00+08:00').getTime();
    const options = {
      HOST: '127.0.0.1',
      PANEL_PASSWORD: '',
      RCLONE_BIN: binary,
      LOCAL_ROOT: root,
      DATA_DIR: path.join(fixture, 'panel'),
      RCLONE_CONFIG: path.join(fixture, 'config', 'rclone.conf'),
      now: () => clock,
    };
    async function start() {
      panel = await createPanel(options);
      assert.equal(panel.engine.ready, true, panel.engine.error);
      server = await new Promise((resolve) => {
        const instance = panel.app.listen(0, '127.0.0.1', () => resolve(instance));
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
    async function put(relative, content) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), content);
    }
    const input = (source, destination, media = {}) => ({
      name: '影视传输验收',
      mode: 'copy',
      source: { remote: 'media_source', path: source },
      destination: { remote: 'media_target', path: destination },
      media: {
        enabled: true,
        preset: 'bundle',
        archive: 'preserve',
        rename: 'preserve',
        conflict: 'skip',
        ...media,
      },
      renameConfirmed: true,
    });
    async function finish(id, desired = 'completed') {
      for (let count = 0; count < 250; count++) {
        await panel.tick();
        const job = await call(`/jobs/${id}`);
        if (job.status === desired) return job;
        if (['completed', 'failed', 'limited', 'blocked', 'stopped'].includes(job.status))
          assert.fail(`期望 ${desired}，实际 ${job.status}: ${JSON.stringify(job)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail(`影视任务超时: ${JSON.stringify(await call(`/jobs/${id}`))}`);
    }
    async function waitVerification(id) {
      for (let count = 0; count < 150; count++) {
        const verification = (await call(`/jobs/${id}`)).verification;
        if (verification && verification.status !== 'running') return verification;
        await panel.tick();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail(`影视校验超时: ${JSON.stringify(await call(`/jobs/${id}`))}`);
    }
    async function prepared(job) {
      for (let count = 0; count < 250; count++) {
        const current = await call(`/jobs/${job.id}`);
        if (!current.mediaPreparing) return current;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail('后台扫描准备超时');
    }
    async function verify(id, mode) {
      await call(`/jobs/${id}/verify`, 'POST', { mode });
      return waitVerification(id);
    }
    async function promptly(operation, message) {
      let timeout;
      try {
        return await Promise.race([
          operation,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error(message)), 3000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    }
    async function latestForSchedule(id, except) {
      for (let count = 0; count < 50; count++) {
        await panel.tick();
        const job = (await call('/jobs')).find(
          (item) => item.scheduleId === id && item.id !== except,
        );
        if (job) return job;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail('定时扫描未创建新任务');
    }
    const scheduleInput = (source, destination, extra = {}) => ({
      ...input(source, destination),
      enabled: false,
      timezone: 'Asia/Shanghai',
      startTime: '00:00',
      dailyBytes: 200 * 1024,
      dailySeconds: 0,
      cutoffMode: 'soft',
      scanIntervalMinutes: 5,
      ...extra,
    });
    let archiveJobId;
    try {
      await start();
      for (const name of ['media_source', 'media_target'])
        await call('/remotes', 'POST', {
          name,
          type: 'local',
          parameters: { no_clone: 'true' },
        });
      await call('/settings', 'PUT', { transfers: 1, checkers: 1, retries: 1, bandwidth: '' });

      await t.test('手动预览与真实传输包含影视配套文件并遵守已有筛选', async () => {
        await put('manual/电影.mkv', 'synthetic movie content');
        await put('manual/电影.zh.srt', 'synthetic subtitles');
        await put('manual/电影.nfo', '<movie/>');
        await put('manual/poster.jpg', 'synthetic poster');
        await put('manual/readme.txt', 'ignore non-media');
        await put('manual/sample.mp4', 'exclude video');
        const request = {
          ...input('manual', 'manual-target'),
          filters: { exclude: ['sample.mp4'] },
        };
        const preview = await call('/media/preview', 'POST', request);
        assert.equal(preview.totalFiles, 4);
        assert.equal(preview.skippedByFilter, 1);
        assert.equal(preview.remainingBytes, preview.totalBytes);
        assert.ok(preview.files.every((file) => file.action === 'copy' && !file.exists));
        const created = await call('/jobs', 'POST', request);
        assert.equal((await prepared(created)).files.length, 4);
        const ended = await finish(created.id);
        assert.ok(
          ended.files.every((file) => file.status === 'completed'),
          JSON.stringify(ended.files),
        );
        assert.deepEqual(
          (await readdir(path.join(root, 'manual-target'))).sort(),
          ['poster.jpg', '电影.mkv', '电影.nfo', '电影.zh.srt'].sort(),
        );
        assert.equal(
          await readFile(path.join(root, 'manual-target/电影.mkv'), 'utf8'),
          'synthetic movie content',
        );
      });

      await t.test('整理命名和规则归档保留源文件，大小及哈希校验使用映射路径', async () => {
        const video = '三体.2023.S01E02.2160p.WEB-DL.mkv';
        await put(`archive/国内/${video}`, 'synthetic episode');
        await put('archive/国内/三体.2023.S01E02.2160p.WEB-DL.zh.ass', 'synthetic subtitle');
        await put('archive/国内/poster.jpg', 'synthetic poster');
        const request = input('archive', 'archive-target', {
          archive: 'rules',
          rename: 'clean',
          rules: [{ pattern: '**/*.mkv', folder: '{type}/{title}/{season}' }],
        });
        const preview = await call('/media/preview', 'POST', request);
        assert.ok(
          preview.files.some(
            (file) => file.targetFile === '剧集/三体/Season 01/三体 (2023) S01E02.mkv',
          ),
        );
        const created = await call('/jobs', 'POST', request);
        archiveJobId = created.id;
        const ended = await finish(created.id);
        for (const file of ended.files)
          assert.deepEqual(
            await readFile(path.join(root, 'archive-target', file.targetFile)),
            await readFile(path.join(root, 'archive', file.sourceFile)),
          );
        for (const mode of ['size', 'hash']) {
          const verification = await verify(created.id, mode);
          assert.equal(verification.status, 'completed', JSON.stringify(verification));
          assert.equal(verification.report.checked, 3);
          if (mode === 'hash') assert.equal(verification.report.hashChecked, 3);
        }
        const targetFile = ended.files.find((file) => file.targetFile.endsWith('.mkv'));
        const original = await readFile(path.join(root, 'archive-target', targetFile.targetFile));
        await writeFile(
          path.join(root, 'archive-target', targetFile.targetFile),
          Buffer.alloc(original.length, 120),
        );
        assert.equal((await verify(created.id, 'size')).status, 'completed');
        const hashCheck = await verify(created.id, 'hash');
        assert.equal(hashCheck.status, 'failed');
        assert.deepEqual(hashCheck.report.differ, [targetFile.targetFile]);
        await writeFile(path.join(root, 'archive-target', targetFile.targetFile), original);
        assert.equal(
          await readFile(path.join(root, 'archive/国内', video), 'utf8'),
          'synthetic episode',
        );
      });

      await t.test('后台哈希校验等待网盘响应时，其他账号任务仍能创建和暂停', async () => {
        for (const name of ['unrelated_source', 'unrelated_target'])
          await call('/remotes', 'POST', {
            name,
            type: 'local',
            parameters: { no_clone: 'true' },
          });
        await put('unrelated/电影.mkv', 'independent movie');
        let release, entered;
        const blockedStat = new Promise((resolve) => {
          release = resolve;
        });
        const statEntered = new Promise((resolve) => {
          entered = resolve;
        });
        const originalCall = panel.engine.call;
        let held = false,
          unrelatedJob;
        panel.engine.call = async function (endpoint, parameters = {}, ...rest) {
          if (
            !held &&
            endpoint === 'operations/stat' &&
            parameters.opt?.showHash &&
            String(parameters.fs).endsWith('/archive')
          ) {
            held = true;
            entered();
            await blockedStat;
          }
          return originalCall.call(this, endpoint, parameters, ...rest);
        };
        try {
          const verification = await promptly(
            call(`/jobs/${archiveJobId}/verify`, 'POST', { mode: 'hash' }),
            '启动后台校验接口被网盘响应阻塞',
          );
          assert.equal(verification.status, 'running');
          await promptly(statEntered, '校验未进入来源文件哈希检查');
          const request = input('unrelated', 'unrelated-target');
          request.source.remote = 'unrelated_source';
          request.destination.remote = 'unrelated_target';
          unrelatedJob = await promptly(
            call('/jobs', 'POST', request),
            '后台校验阻塞了其他账号的新建任务接口',
          );
          await promptly(
            call(`/jobs/${unrelatedJob.id}/pause`, 'POST', {}),
            '后台校验阻塞了其他账号的暂停接口',
          );
          assert.equal((await call(`/jobs/${archiveJobId}`)).verification.status, 'running');
        } finally {
          release();
          panel.engine.call = originalCall;
        }
        const verification = await waitVerification(archiveJobId);
        assert.equal(verification.status, 'completed', JSON.stringify(verification));
        await finish(unrelatedJob.id, 'paused');
        await call(`/jobs/${unrelatedJob.id}/resume`, 'POST', {});
        await finish(unrelatedJob.id);
      });

      await t.test('目标已有文件默认保留、不同大小显示冲突，显式覆盖才替换', async () => {
        await put('existing/保留.mkv', 'original');
        await put('existing/冲突.mkv', 'source');
        await put('existing-target/保留.mkv', 'original');
        await put('existing-target/冲突.mkv', 'keep existing larger file');
        const request = input('existing', 'existing-target');
        const preview = await call('/media/preview', 'POST', request);
        assert.equal(preview.skippedExisting, 1);
        assert.equal(preview.conflicts, 1);
        assert.equal(preview.remainingBytes, 0);
        assert.equal(
          preview.files.find((file) => file.sourceFile === '冲突.mkv').action,
          'conflict',
        );
        const created = await call('/jobs', 'POST', request);
        const ended = await finish(created.id);
        assert.equal(ended.stats.bytes, 0);
        assert.equal(ended.stats.conflicts, 1);
        assert.ok(ended.files.every((file) => file.status === 'skipped'));
        assert.match(
          ended.files.find((file) => file.sourceFile === '冲突.mkv').reason,
          /大小或共同哈希不同/,
        );
        assert.equal(ended.files.find((file) => file.sourceFile === '冲突.mkv').error, '');
        assert.equal(
          await readFile(path.join(root, 'existing-target/冲突.mkv'), 'utf8'),
          'keep existing larger file',
        );
        const overwrite = { ...request, media: { ...request.media, conflict: 'overwrite' } };
        assert.equal((await call('/media/preview', 'POST', overwrite)).conflicts, 0);
        await finish((await call('/jobs', 'POST', overwrite)).id);
        assert.equal(await readFile(path.join(root, 'existing-target/冲突.mkv'), 'utf8'), 'source');
      });

      await t.test('多个来源隔离同名文件，再次扫描只传新增文件', async () => {
        await put('multi/电影/同名.mkv', 'movie');
        await put('multi/剧集/同名.mkv', 'episode');
        const request = {
          ...input('multi', 'multi-target'),
          sourcePaths: ['multi/电影', 'multi/剧集'],
        };
        const preview = await call('/media/preview', 'POST', request);
        assert.deepEqual(
          preview.files.map((file) => file.targetFile).sort(),
          ['电影/同名.mkv', '剧集/同名.mkv'].sort(),
        );
        await finish((await call('/jobs', 'POST', request)).id);
        await put('multi/电影/新增.mkv', 'new movie');
        const next = await call('/media/preview', 'POST', request);
        assert.equal(next.totalFiles, 3);
        assert.equal(next.skippedExisting, 2);
        assert.equal(next.remainingBytes, Buffer.byteLength('new movie'));
        const ended = await finish((await call('/jobs', 'POST', request)).id);
        assert.equal(ended.files.filter((file) => file.status === 'completed').length, 1);
        assert.equal(ended.files.filter((file) => file.status === 'skipped').length, 2);
        assert.equal(
          await readFile(path.join(root, 'multi-target/电影/同名.mkv'), 'utf8'),
          'movie',
        );
        assert.equal(
          await readFile(path.join(root, 'multi-target/剧集/同名.mkv'), 'utf8'),
          'episode',
        );
      });

      await t.test('真实缺失源文件记录失败，失败重试使用可信原归档映射', async () => {
        await put('retry/a.2023.1080p.mkv', 'good movie');
        await put('retry/b.2023.1080p.mkv', 'repair me');
        const request = input('retry', 'retry-target', {
          archive: 'rules',
          rename: 'clean',
          rules: [{ pattern: '*.mkv', folder: '电影/{title}' }],
        });
        const created = await call('/jobs', 'POST', request);
        await prepared(created);
        await unlink(path.join(root, 'retry/b.2023.1080p.mkv'));
        const failed = await finish(created.id, 'failed');
        assert.equal(failed.files.filter((file) => file.status === 'failed').length, 1);
        assert.equal(failed.files.filter((file) => file.status === 'completed').length, 1);
        await put('retry/b.2023.1080p.mkv', 'repair me');
        const retry = await call(`/jobs/${created.id}/retry-files`, 'POST', {
          mediaRetryFiles: [
            {
              source: { remote: 'media_source', path: 'manual' },
              sourceFile: '电影.mkv',
              targetFile: 'evil.mkv',
              path: 'evil.mkv',
              size: 1,
            },
          ],
        });
        Object.assign(retry, await prepared(retry));
        assert.equal(retry.files.length, 1);
        assert.equal(retry.files[0].sourceFile, 'b.2023.1080p.mkv');
        assert.equal(retry.files[0].targetFile, '电影/b/b (2023).mkv');
        assert.equal(retry.files[0].source.path, 'retry');
        await finish(retry.id);
        assert.equal(
          await readFile(path.join(root, 'retry-target/电影/b/b (2023).mkv'), 'utf8'),
          'repair me',
        );
        await assert.rejects(readFile(path.join(root, 'retry-target/evil.mkv')), {
          code: 'ENOENT',
        });
      });

      await t.test('大文件暂停后服务重启仍暂停，恢复后逐文件清单保持完整', async () => {
        await put('pause/large.mkv', Buffer.alloc(1024 ** 2, 7));
        await call('/settings', 'PUT', { transfers: 1, checkers: 1, retries: 1, bandwidth: '32K' });
        const created = await call('/jobs', 'POST', input('pause', 'pause-target'));
        await panel.tick();
        await new Promise((resolve) => setTimeout(resolve, 100));
        await call(`/jobs/${created.id}/pause`, 'POST', {});
        const paused = await finish(created.id, 'paused');
        assert.equal(paused.files.length, 1);
        assert.ok(
          ['pending', 'running'].includes(paused.files[0].status),
          JSON.stringify(paused.files),
        );
        await close();
        await start();
        await panel.tick();
        assert.equal((await call(`/jobs/${created.id}`)).status, 'paused');
        const historical = await call(`/jobs/${archiveJobId}`);
        assert.equal(historical.files.length, 3);
        assert.ok(
          historical.files.every(
            (file) => file.sourceFile && file.targetFile && file.status === 'completed',
          ),
        );
        let releaseStat, enteredStat;
        const blockedStat = new Promise((resolve) => {
          releaseStat = resolve;
        });
        const statEntered = new Promise((resolve) => {
          enteredStat = resolve;
        });
        const originalCall = panel.engine.call;
        let held = false;
        panel.engine.call = async function (endpoint, parameters = {}, ...rest) {
          if (
            !held &&
            endpoint === 'operations/stat' &&
            parameters.opt?.showHash &&
            String(parameters.fs).endsWith('/pause')
          ) {
            held = true;
            enteredStat();
            await blockedStat;
          }
          return originalCall.call(this, endpoint, parameters, ...rest);
        };
        const beforeVerification = await call(`/jobs/${created.id}`);
        try {
          assert.equal(
            (
              await promptly(
                call(`/jobs/${created.id}/verify`, 'POST', { mode: 'hash' }),
                '暂停任务的后台校验未及时启动',
              )
            ).status,
            'running',
          );
          await promptly(statEntered, '暂停任务的来源校验没有进入阻塞点');
          for (const action of ['resume', 'retry-files']) {
            await promptly(
              call(`/jobs/${created.id}/${action}`, 'POST', {}, 409),
              `校验期间 ${action} 请求没有及时被拒绝`,
            );
            const unchanged = await call(`/jobs/${created.id}`);
            assert.equal(unchanged.status, 'paused');
            assert.equal(unchanged.attempts, beforeVerification.attempts);
            assert.deepEqual(unchanged.files, beforeVerification.files);
            assert.equal(unchanged.verification.status, 'running');
          }
        } finally {
          releaseStat();
          panel.engine.call = originalCall;
        }
        await waitVerification(created.id);
        await call('/settings', 'PUT', { transfers: 1, checkers: 1, retries: 1, bandwidth: '' });
        await call(`/jobs/${created.id}/resume`, 'POST', {});
        const resumed = await finish(created.id);
        assert.equal(resumed.files.length, 1);
        assert.equal(resumed.files[0].status, 'completed');
        assert.deepEqual(
          await readFile(path.join(root, 'pause-target/large.mkv')),
          await readFile(path.join(root, 'pause/large.mkv')),
        );
      });

      await t.test('每五分钟扫描增量，共享当天预算并避免同周期重复运行', async () => {
        await put('interval/a.mkv', Buffer.alloc(40 * 1024, 65));
        const schedule = await call(
          '/schedules',
          'POST',
          scheduleInput('interval', 'interval-target'),
        );
        const first = await call(`/schedules/${schedule.id}/run`, 'POST', {});
        await finish(first.id);
        assert.equal(
          (await call('/schedules')).find((item) => item.id === schedule.id).today.bytes,
          40 * 1024,
        );
        await call(`/schedules/${schedule.id}/toggle`, 'POST', { enabled: true });
        await panel.tick();
        assert.equal(
          (await call('/jobs')).filter((job) => job.scheduleId === schedule.id).length,
          1,
        );
        await put('interval/b.mkv', Buffer.alloc(40 * 1024, 66));
        clock += 6 * 60000;
        const second = await latestForSchedule(schedule.id, first.id);
        const ended = await finish(second.id);
        assert.equal(ended.stats.bytes, 40 * 1024);
        const latest = (await call('/schedules')).find((item) => item.id === schedule.id);
        assert.equal(latest.today.bytes, 80 * 1024);
        await panel.tick();
        assert.equal(
          (await call('/jobs')).filter((job) => job.scheduleId === schedule.id).length,
          2,
        );
        await call(`/schedules/${schedule.id}/toggle`, 'POST', { enabled: false });
      });

      await t.test('计划失败文件重试保留计划和剩余额度，预算耗尽后不能绕过每日限制', async () => {
        for (const [index, name] of ['a.mkv', 'b.mkv', 'c.mkv'].entries())
          await put(`schedule-retry/${name}`, Buffer.alloc(40 * 1024, index + 70));
        const schedule = await call(
          '/schedules',
          'POST',
          scheduleInput('schedule-retry', 'schedule-retry-target', {
            dailyBytes: 100 * 1024,
            dailySeconds: 120,
          }),
        );
        const originalCall = panel.engine.call;
        let injected = false,
          copyCalls = 0;
        panel.engine.call = async function (endpoint, parameters = {}, ...rest) {
          if (endpoint === 'operations/copyfile') {
            copyCalls++;
            if (!injected) {
              injected = true;
              return { jobid: 9000000 };
            }
          }
          if (endpoint === 'job/status' && parameters.jobid === 9000000)
            return {
              finished: true,
              success: false,
              error: 'synthetic permanent file failure',
              endTime: new Date().toISOString(),
            };
          return originalCall.call(this, endpoint, parameters, ...rest);
        };
        try {
          const first = await call(`/schedules/${schedule.id}/run`, 'POST', {});
          const failed = await finish(first.id, 'failed');
          assert.equal(failed.files.filter((file) => file.status === 'failed').length, 1);
          assert.equal(failed.files.filter((file) => file.status === 'completed').length, 2);
          const usedBeforeRetry = (await call('/schedules')).find(
            (item) => item.id === schedule.id,
          ).today;
          assert.equal(usedBeforeRetry.bytes, 80 * 1024);
          assert.ok(usedBeforeRetry.seconds > 0);
          const retry = await call(`/jobs/${first.id}/retry-files`, 'POST', {});
          assert.equal(retry.scheduleId, schedule.id);
          assert.equal(retry.manualScheduleRun, true);
          assert.equal(retry.limits.bytes, 20 * 1024);
          assert.equal(retry.limits.seconds, 120 - usedBeforeRetry.seconds);
          Object.assign(retry, await prepared(retry));
          assert.equal(retry.files.length, 1);
          assert.equal(retry.files[0].source.path, 'schedule-retry');
          assert.equal(
            retry.files[0].targetFile,
            failed.files.find((file) => file.status === 'failed').targetFile,
          );
          const completed = await finish(retry.id);
          assert.equal(completed.stats.bytes, 40 * 1024);
          const exhausted = (await call('/schedules')).find((item) => item.id === schedule.id);
          assert.equal(exhausted.today.bytes, 120 * 1024);
          assert.ok(exhausted.today.seconds > usedBeforeRetry.seconds);
          const attemptsBeforeExhaustedRetry = copyCalls;
          const blockedRetry = await call(`/jobs/${first.id}/retry-files`, 'POST', {});
          assert.equal(blockedRetry.scheduleId, schedule.id);
          assert.equal(blockedRetry.status, 'limited');
          assert.equal(blockedRetry.attempts, 0);
          await panel.tick();
          assert.equal(copyCalls, attemptsBeforeExhaustedRetry);
          assert.equal(
            (await call('/schedules')).find((item) => item.id === schedule.id).today.bytes,
            exhausted.today.bytes,
          );
          for (const name of ['a.mkv', 'b.mkv', 'c.mkv'])
            assert.deepEqual(
              await readFile(path.join(root, 'schedule-retry-target', name)),
              await readFile(path.join(root, 'schedule-retry', name)),
            );
        } finally {
          panel.engine.call = originalCall;
        }
      });

      await t.test('三次单文件复制软额度累计首日80KiB，次日只补剩余40KiB', async () => {
        for (const [index, name] of ['a.mkv', 'b.mkv', 'c.mkv'].entries())
          await put(`quota/${name}`, Buffer.alloc(40 * 1024, index + 65));
        const schedule = await call(
          '/schedules',
          'POST',
          scheduleInput('quota', 'quota-target', { dailyBytes: 70 * 1024 }),
        );
        const first = await call(`/schedules/${schedule.id}/run`, 'POST', {});
        const limited = await finish(first.id, 'limited');
        assert.equal(limited.limitReason, 'bytes_limit');
        assert.equal(limited.stats.bytes, 80 * 1024, JSON.stringify(limited.stats));
        assert.equal(limited.files.filter((file) => file.status === 'completed').length, 2);
        assert.equal(
          (await readdir(path.join(root, 'quota-target'))).filter((name) => name.endsWith('.mkv'))
            .length,
          2,
        );
        const day = (await call('/schedules')).find((item) => item.id === schedule.id).today;
        assert.equal(day.bytes, 80 * 1024);
        await call(`/schedules/${schedule.id}/run`, 'POST', {}, 409);
        await call(`/schedules/${schedule.id}/toggle`, 'POST', { enabled: true });
        clock += 6 * 60000;
        await panel.tick();
        assert.equal(
          (await call('/jobs')).filter((job) => job.scheduleId === schedule.id).length,
          1,
        );
        clock += 86400000;
        const next = await latestForSchedule(schedule.id, first.id);
        const completed = await finish(next.id);
        assert.equal(completed.stats.bytes, 40 * 1024);
        assert.equal(completed.files.filter((file) => file.status === 'skipped').length, 2);
        assert.equal(
          (await call('/schedules')).find((item) => item.id === schedule.id).today.bytes,
          40 * 1024,
        );
        await panel.tick();
        assert.equal(
          (await call('/jobs')).filter((job) => job.scheduleId === schedule.id).length,
          2,
        );
        await call(`/schedules/${schedule.id}/toggle`, 'POST', { enabled: false });
        for (const name of ['a.mkv', 'b.mkv', 'c.mkv'])
          assert.deepEqual(
            await readFile(path.join(root, 'quota-target', name)),
            await readFile(path.join(root, 'quota', name)),
          );
      });

      await t.test('预览只展示前200项，真实任务完整保存201条文件清单', async () => {
        for (let index = 0; index < 201; index++) await put(`manifest/${index}.mkv`, 'x');
        const request = input('manifest', 'manifest-target');
        const preview = await call('/media/preview', 'POST', request);
        assert.equal(preview.totalFiles, 201);
        assert.equal(preview.files.length, 200);
        assert.equal(preview.truncated, true);
        const created = await call('/jobs', 'POST', { ...request, dryRun: true });
        const completed = await finish(created.id);
        assert.equal(completed.files.length, 201);
        assert.ok(completed.files.every((file) => file.status === 'planned'));
        const persisted = JSON.parse(
          await readFile(path.join(fixture, 'panel/state.json'), 'utf8'),
        );
        assert.equal(persisted.jobs.find((job) => job.id === created.id).files.length, 201);
      });
    } finally {
      await close();
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
