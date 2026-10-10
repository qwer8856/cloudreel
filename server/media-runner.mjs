import { randomBytes } from 'node:crypto';
import { AppError, cleanPath, safeError } from './validation.mjs';
import { planMediaTransfer, validateMediaOptions } from './media.mjs';

const missing = (error) =>
  /directory not found|object not found|file not found|does not exist|couldn't find directory/i.test(
    error.message,
  );
const ended = (success, error = '') => ({
  finished: true,
  success,
  error,
  endTime: new Date().toISOString(),
});
const FILE_CHECK_BATCH_SIZE = 50;

function comparison(file, item) {
  if (!item) return { exists: false, sameSize: false, comparison: 'missing' };
  if (item.IsDir) return { exists: true, sameSize: false, comparison: 'directory' };
  const sameSize = Number(item.Size) === file.size;
  const common = Object.entries(file.hashes || {}).filter(
    ([key, value]) => value && item.Hashes?.[key],
  );
  const hashEqual =
    common.length &&
    common.every(
      ([key, value]) => String(value).toLowerCase() === String(item.Hashes[key]).toLowerCase(),
    );
  return {
    exists: true,
    sameSize,
    comparison:
      !sameSize || (common.length && !hashEqual)
        ? 'different'
        : hashEqual
          ? 'hash_match'
          : 'same_size',
  };
}

export class MediaRunner {
  constructor(context) {
    Object.assign(this, context);
  }

  async plan(input) {
    if (input.mediaRetryFiles?.length) {
      const files = input.mediaRetryFiles.map((file) => ({
        path: cleanPath(file.path),
        source: { remote: file.source.remote, path: cleanPath(file.source.path) },
        sourceFile: cleanPath(file.sourceFile),
        targetFile: cleanPath(file.targetFile),
        size: Number(file.size),
        hashes: file.hashes || {},
      }));
      for (const file of files) {
        await this.resolveFs(file.source);
        const current = await this.stat(
          file.source,
          file.sourceFile,
          Boolean(Object.keys(file.hashes).length),
        );
        if (current && !current.IsDir) {
          file.size = Number(current.Size);
          file.hashes = current.Hashes || {};
        }
      }
      return {
        files,
        totalFiles: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        skippedByFilter: 0,
      };
    }
    return planMediaTransfer(input, {
      listFiles: (value) => this.listFiles(value),
      resolveFs: (value) => this.resolveFs(value),
    });
  }

  async targetSnapshot(destination) {
    const target = await this.resolveFs(destination);
    try {
      const result = await this.engine.call(
        'operations/list',
        { fs: target.fs, remote: '', opt: { recurse: true, noModTime: true, noMimeType: true } },
        120000,
      );
      if ((result.list || []).length > 100000)
        throw new AppError('目标目录超过 100000 项，请选择更小的目标目录。');
      return new Map((result.list || []).map((item) => [item.Path, item]));
    } catch (error) {
      if (missing(error)) return new Map();
      throw error;
    }
  }

  async stat(destination, relative, hashes = false, job) {
    const target = await this.resolveFs(destination, job);
    try {
      const result = await this.engine.call('operations/stat', {
        fs: target.fs,
        remote: cleanPath(relative),
        opt: { showHash: hashes, noModTime: true, noMimeType: true },
      });
      return result.item || null;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async preview(input) {
    const plan = await this.plan(input);
    const target = await this.targetSnapshot(input.destination);
    const options = validateMediaOptions(input.media);
    let skippedExisting = 0,
      conflicts = 0,
      remainingBytes = 0;
    const files = plan.files.map((file) => {
      const check = comparison(file, target.get(file.targetFile));
      const action =
        check.comparison === 'directory'
          ? 'conflict'
          : check.exists && options.conflict === 'skip'
            ? ['same_size', 'hash_match'].includes(check.comparison)
              ? 'skip'
              : 'conflict'
            : 'copy';
      if (action === 'skip') skippedExisting++;
      if (action === 'conflict') conflicts++;
      if (action === 'copy') remainingBytes += file.size;
      return { ...file, ...check, action };
    });
    const budget = Number(input.dailyBytes) || 0;
    const oversized = budget ? plan.files.filter((file) => file.size > budget) : [];
    return {
      ...plan,
      files: files.slice(0, 200),
      skippedExisting,
      conflicts,
      remainingBytes,
      largest: plan.files.reduce((value, file) => Math.max(value, file.size), 0),
      oversizedCount: oversized.length,
      oversized: oversized.slice(0, 20).map((file) => ({ path: file.path, size: file.size })),
      truncated: files.length > 200,
    };
  }

  async start(job) {
    const plan = await this.plan(job);
    if (
      !job.dryRun &&
      job.driveMaxFileBytes &&
      plan.files.some((file) => file.size > job.driveMaxFileBytes)
    )
      throw new AppError(
        '文件超过 Google group 所有账号的单次预算，请提高账号预算或调整来源文件。',
      );
    job.files = plan.files.map((file) => ({
      ...file,
      key: randomBytes(8).toString('hex'),
      status: 'pending',
      bytes: 0,
      error: '',
      attempt: job.attempts,
    }));
    job.mediaTotalBytes = plan.totalBytes;
    job.mediaSkippedByFilter = plan.skippedByFilter;
    job.mediaIndex = 0;
    job.mediaFailure = '';
    job.jobId = null;
    job.currentFile = null;
    job.stats = {
      bytes: 0,
      totalBytes: plan.totalBytes,
      speed: 0,
      transfers: 0,
      totalTransfers: plan.totalFiles,
      skipped: 0,
    };
  }

  summarize(job, stats) {
    const complete = job.files.filter((file) =>
      ['completed', 'skipped', 'planned'].includes(file.status),
    );
    const active = job.files[job.mediaIndex];
    if (active?.status === 'running') {
      active.bytes = Math.min(
        active.size,
        (stats.transferring || []).reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
      );
      active.speed = Number(stats.speed) || 0;
    }
    return {
      bytes: Number(stats.bytes) || 0,
      totalBytes: job.mediaTotalBytes,
      speed: Number(stats.speed) || 0,
      transfers: job.files.filter((file) => file.status === 'completed').length,
      totalTransfers: job.files.length,
      skipped: job.files.filter((file) => file.status === 'skipped').length,
      conflicts: job.files.filter(
        (file) => file.status === 'skipped' && ['different', 'directory'].includes(file.check),
      ).length,
      completedBytes:
        complete.reduce((sum, file) => sum + file.size, 0) +
        (active?.status === 'running' ? active.bytes : 0),
      eta: stats.eta ?? null,
    };
  }

  fail(job, file, error, stats) {
    file.status = 'failed';
    file.error = safeError(error.message);
    file.speed = 0;
    file.at = new Date().toISOString();
    job.mediaFailure ||= file.error;
    job.jobId = null;
    job.currentFile = null;
    return { status: ended(false, file.error), stats: this.summarize(job, stats) };
  }

  async poll(job) {
    let stats = await this.engine.call('core/stats', { group: job.group });
    if (job.jobId !== null && job.jobId !== undefined) {
      const status = await this.engine.call('job/status', { jobid: job.jobId });
      if (!status.finished) return { status, stats: this.summarize(job, stats) };
      stats = await this.engine.call('core/stats', { group: job.group });
      const file = job.files[job.mediaIndex];
      if (file) {
        file.at = status.endTime || new Date().toISOString();
        file.speed = 0;
        if (job.stopping) file.status = 'pending';
        else if (!status.success) {
          file.status = 'failed';
          file.error = safeError(status.error || '文件传输失败。');
          job.mediaFailure ||= file.error;
          if (
            /max transfer limit|transfer limit reached|max duration|duration limit|uploadLimitExceeded|dailyLimitExceeded|upload limit reached|401|403|429|unauthor|登录|认证|授权|timeout|connection|network|无法连接|请求超时/i.test(
              file.error,
            )
          ) {
            job.jobId = null;
            job.currentFile = null;
            return { status: ended(false, file.error), stats: this.summarize(job, stats) };
          }
        } else {
          let check;
          try {
            check = comparison(
              file,
              await this.stat(
                job.destination,
                file.targetFile,
                Boolean(Object.keys(file.hashes).length),
                job,
              ),
            );
          } catch (error) {
            return this.fail(job, file, error, stats);
          }
          if (!check.sameSize || check.comparison === 'different') {
            file.status = 'failed';
            file.error = '传输后目标文件大小或哈希不一致。';
            job.mediaFailure ||= file.error;
          } else {
            file.status = 'completed';
            file.bytes = file.size;
            file.check = check.comparison;
          }
        }
      }
      job.jobId = null;
      job.currentFile = null;
      if (!job.stopping) job.mediaIndex++;
    }
    if (job.stopping)
      return { status: ended(false, '操作已停止。'), stats: this.summarize(job, stats) };
    let processed = 0;
    while (job.mediaIndex < job.files.length) {
      if (processed >= FILE_CHECK_BATCH_SIZE)
        return { status: { finished: false }, stats: this.summarize(job, stats) };
      const file = job.files[job.mediaIndex];
      let check;
      try {
        check = comparison(
          file,
          await this.stat(
            job.destination,
            file.targetFile,
            Boolean(Object.keys(file.hashes).length),
            job,
          ),
        );
      } catch (error) {
        return this.fail(job, file, error, stats);
      }
      const options = validateMediaOptions(job.media);
      if (check.comparison === 'directory' || (check.exists && options.conflict === 'skip')) {
        file.status = 'skipped';
        file.check = check.comparison;
        file.error = ['different', 'directory'].includes(check.comparison)
          ? '目标同名文件不同或为目录，已保留目标。'
          : '';
        file.at = new Date().toISOString();
        job.mediaIndex++;
        processed++;
        continue;
      }
      if (job.dryRun) {
        file.status = 'planned';
        file.at = new Date().toISOString();
        job.mediaIndex++;
        processed++;
        continue;
      }
      const bytes = job.limits.bytes ? job.limits.bytes - (Number(stats.bytes) || 0) : 0;
      const seconds = job.limits.seconds
        ? job.limits.seconds - (Date.now() - Date.parse(job.startedAt)) / 1000
        : 0;
      if ((job.limits.bytes && bytes <= 0) || (job.limits.seconds && seconds <= 0))
        return {
          status: ended(
            false,
            job.limits.bytes && bytes <= 0 ? 'max transfer limit reached' : 'max duration reached',
          ),
          stats: this.summarize(job, stats),
        };
      try {
        const [source, destination] = await Promise.all([
          this.resolveFs(file.source),
          this.resolveFs(job.destination, job),
        ]);
        const result = await this.engine.call('operations/copyfile', {
          srcFs: source.fs,
          srcRemote: file.sourceFile,
          dstFs: destination.fs,
          dstRemote: file.targetFile,
          _async: true,
          _group: job.group,
          _config: {
            ...this.settings(),
            DryRun: false,
            DisableFeatures: ['Copy', 'Move'],
            MaxTransfer: job.limits.bytes || -1,
            MaxDuration: seconds > 0 ? `${Math.max(0.001, seconds)}s` : '0s',
            CutoffMode: job.limits.cutoffMode.toUpperCase(),
          },
        });
        file.status = 'running';
        file.bytes = 0;
        file.error = '';
        job.jobId = result.jobid;
        job.currentFile = file.path;
        return { status: { finished: false }, stats: this.summarize(job, stats) };
      } catch (error) {
        return this.fail(job, file, error, stats);
      }
    }
    return {
      status: ended(!job.mediaFailure, job.mediaFailure),
      stats: this.summarize(job, stats),
    };
  }

  async verify(job, mode, { active = () => true, onProgress = async () => {} } = {}) {
    const report = {
      match: [],
      differ: [],
      missingOnDst: [],
      error: [],
      checked: 0,
      hashChecked: 0,
      sizeChecked: 0,
    };
    for (const file of job.files) {
      if (!active()) throw new AppError('校验已中断。', 409);
      if (file.status === 'planned') continue;
      try {
        const source = await this.stat(file.source, file.sourceFile, mode === 'hash');
        if (!source || source.IsDir) {
          report.error.push(file.path);
          continue;
        }
        const target = await this.stat(job.destination, file.targetFile, mode === 'hash', job);
        const check = comparison(
          {
            ...file,
            size: Number(source.Size),
            hashes: mode === 'hash' ? source.Hashes || {} : {},
          },
          target,
        );
        report.checked++;
        if (!target) report.missingOnDst.push(file.targetFile);
        else if (!check.sameSize || check.comparison === 'different')
          report.differ.push(file.targetFile);
        else {
          report.match.push(file.targetFile);
          if (check.comparison === 'hash_match') report.hashChecked++;
          else report.sizeChecked++;
        }
      } catch (error) {
        report.error.push(`${file.path}：${safeError(error.message)}`);
      }
      if (report.checked && report.checked % 25 === 0) await onProgress(report);
    }
    if (!active()) throw new AppError('校验已中断。', 409);
    report.success = !report.differ.length && !report.missingOnDst.length && !report.error.length;
    return report;
  }
}
