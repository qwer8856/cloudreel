import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AppError, cleanPath, safeError } from './validation.mjs';
import { rcloneFilter, transferOptions } from './operations.mjs';

const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const TTL = 3600000;
const MAX_FILES = 100000;
const missing = (error) =>
  /directory not found|object not found|file not found|does not exist|couldn't find directory/i.test(
    error.message,
  );
const canonical = (value) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
export function scanInput(input) {
  return {
    mode: 'copy',
    source: { remote: input.source?.remote, path: cleanPath(input.source?.path ?? '') },
    destination: {
      remote: input.destination?.remote,
      path: cleanPath(input.destination?.path ?? ''),
    },
    ...transferOptions({ ...input, mode: 'copy' }),
  };
}
const signature = (input) =>
  createHash('sha256')
    .update(canonical(scanInput(input)))
    .digest('hex');

export class MediaScans {
  constructor(context) {
    Object.assign(this, { now: Date.now, ...context });
    this.folder = path.join(this.dataDir, 'scans');
    this.records = new Map();
    this.sequence = 0;
    this.closed = false;
  }
  file(id, plan = false) {
    return path.join(this.folder, `${id}${plan ? '.plan' : ''}.json`);
  }
  async init() {
    await mkdir(this.folder, { recursive: true, mode: 0o700 });
    for (const filename of await readdir(this.folder)) {
      const match = /^([a-f0-9]{32})\.json$/.exec(filename);
      if (!match) continue;
      let record;
      try {
        record = JSON.parse(await readFile(this.file(match[1]), 'utf8'));
      } catch (error) {
        if (error instanceof SyntaxError || error.code === 'ENOENT') continue;
        throw error;
      }
      if (record.id !== match[1] || !record.input || !record.progress) continue;
      this.sequence = Math.max(this.sequence, record.sequence || 0);
      if (ACTIVE.has(record.status)) {
        record.status = 'interrupted';
        record.error = '服务重启，扫描已中断，请重新扫描。';
        record.finishedAt = this.now();
        await this.save(record);
      }
      this.records.set(record.id, record);
    }
    await this.prune();
  }
  metadata(record) {
    const {
      id,
      sequence,
      input,
      binding,
      signature: inputSignature,
      status,
      phase,
      progress,
      currentPath,
      startedAt,
      finishedAt,
      expiresAt,
      result,
      error,
    } = record;
    return {
      id,
      sequence,
      input,
      binding,
      signature: inputSignature,
      status,
      phase,
      progress,
      currentPath,
      startedAt,
      finishedAt,
      expiresAt,
      result,
      error,
    };
  }
  view(record) {
    const { binding, sequence, signature: ignored, ...view } = this.metadata(record);
    return {
      ...view,
      elapsedSeconds: Math.max(
        0,
        Math.floor(((record.finishedAt || this.now()) - record.startedAt) / 1000),
      ),
    };
  }
  get(id) {
    const record = this.records.get(id);
    if (!record) throw new AppError('扫描记录不存在，请重新扫描。', 404);
    if (!ACTIVE.has(record.status) && record.expiresAt <= this.now())
      throw new AppError('扫描结果已过期，请重新扫描。', 410);
    return record;
  }
  list() {
    return [...this.records.values()]
      .filter((r) => ACTIVE.has(r.status) || r.expiresAt > this.now())
      .map((r) => this.view(r));
  }
  uses(remote) {
    return [...this.records.values()].some(
      (r) =>
        ACTIVE.has(r.status) &&
        [r.input.source.remote, r.input.destination.remote].includes(remote),
    );
  }
  async save(record) {
    await writeFile(`${this.file(record.id)}.tmp`, JSON.stringify(this.metadata(record)), {
      mode: 0o600,
    });
    await rename(`${this.file(record.id)}.tmp`, this.file(record.id));
  }
  async remove(record) {
    this.records.delete(record.id);
    for (const filename of [this.file(record.id), this.file(record.id, true)])
      await unlink(filename).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
  }
  async prune(maximum = 6) {
    for (const record of [...this.records.values()])
      if (!ACTIVE.has(record.status) && record.expiresAt <= this.now()) await this.remove(record);
    const finished = [...this.records.values()]
      .filter((r) => !ACTIVE.has(r.status))
      .sort((a, b) => (a.sequence || 0) - (b.sequence || 0) || a.startedAt - b.startedAt);
    while (this.records.size > maximum && finished.length) await this.remove(finished.shift());
  }
  async create(input) {
    if (this.closed) throw new AppError('服务正在关闭，请稍后重试。', 503);
    if ([...this.records.values()].filter((r) => ACTIVE.has(r.status)).length >= 2)
      throw new AppError('已有两个扫描任务，请等待完成或取消后再创建。', 429);
    await this.prune(5);
    const normalized = scanInput(input);
    const record = {
      id: randomBytes(16).toString('hex'),
      sequence: ++this.sequence,
      input: normalized,
      signature: signature(input),
      binding: await this.binding(normalized),
      status: 'queued',
      phase: 'source',
      currentPath: '',
      progress: {
        directoriesDone: 0,
        directoriesFound: 0,
        filesFound: 0,
        bytesFound: 0,
        matchedFiles: 0,
        targetDirectoriesDone: 0,
        targetDirectoriesTotal: 0,
      },
      startedAt: this.now(),
      expiresAt: this.now() + TTL,
      error: '',
      controller: new AbortController(),
    };
    this.records.set(record.id, record);
    try {
      await this.save(record);
    } catch (error) {
      this.records.delete(record.id);
      throw error;
    }
    record.run = this.run(record);
    return this.view(record);
  }
  async directory(record, fs, remote, filter) {
    record.controller.signal.throwIfAborted();
    const result = await this.engine.call(
      'operations/list',
      {
        fs,
        remote,
        opt: { recurse: false, noModTime: true, noMimeType: true },
        ...(filter ? { _filter: filter } : {}),
      },
      300000,
      false,
      record.controller.signal,
    );
    record.controller.signal.throwIfAborted();
    if (!Array.isArray(result.list)) throw new AppError('目录列表响应无效。', 502);
    // Providers must return direct children relative to the filesystem root.
    for (const item of result.list) {
      if (
        typeof item.Path !== 'string' ||
        !item.Path ||
        cleanPath(item.Path) !== item.Path ||
        path.posix.dirname(item.Path) !== (remote || '.')
      )
        throw new AppError('扫描收到不安全或不属于当前目录的文件路径。', 502);
    }
    return result.list;
  }
  async sourceFiles(record, input) {
    const source = await this.resolveFs(input.source);
    const options = transferOptions(input),
      selected = options.selections;
    const stack = [''],
      seen = new Set(),
      files = [];
    record.progress.directoriesFound++;
    while (stack.length) {
      const remote = stack.pop();
      record.currentPath = [input.source.path, remote].filter(Boolean).join('/');
      const items = await this.directory(record, source.fs, remote, rcloneFilter(options.filters));
      for (const item of items) {
        if (item.IsDir) {
          if (
            selected.length &&
            !selected.some(
              (s) =>
                s.path === item.Path ||
                s.path.startsWith(`${item.Path}/`) ||
                (s.isDir && item.Path.startsWith(`${s.path}/`)),
            )
          )
            continue;
          if (seen.has(item.Path)) throw new AppError('来源目录响应重复，请重新扫描。', 502);
          seen.add(item.Path);
          if (seen.size > MAX_FILES)
            throw new AppError('来源目录超过 100000 个子目录，请拆分扫描。');
          stack.push(item.Path);
          record.progress.directoriesFound++;
        } else {
          record.progress.filesFound++;
          if (record.progress.filesFound > MAX_FILES)
            throw new AppError('来源超过 100000 个文件，请缩小来源或拆分传输任务。');
          const size = Number(item.Size);
          if (!Number.isSafeInteger(size) || size < 0)
            throw new AppError('来源文件大小无效。', 502);
          record.progress.bytesFound += size;
          if (
            !selected.length ||
            selected.some((s) =>
              s.isDir ? item.Path.startsWith(`${s.path}/`) : item.Path === s.path,
            )
          )
            files.push(item);
        }
      }
      record.progress.directoriesDone++;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return files;
  }
  async target(record, plan) {
    const destination = await this.resolveFs(record.input.destination);
    const wanted = new Set(plan.files.map((f) => f.targetFile));
    const parents = [
      ...new Set(
        plan.files.map((f) =>
          path.posix.dirname(f.targetFile) === '.' ? '' : path.posix.dirname(f.targetFile),
        ),
      ),
    ];
    const target = new Map();
    record.progress.targetDirectoriesTotal = parents.length;
    for (const remote of parents) {
      record.currentPath = [record.input.destination.path, remote].filter(Boolean).join('/');
      try {
        for (const item of await this.directory(record, destination.fs, remote))
          if (wanted.has(item.Path)) target.set(item.Path, item);
      } catch (error) {
        if (!missing(error)) throw error;
      }
      record.progress.targetDirectoriesDone++;
    }
    return target;
  }
  async run(record) {
    try {
      record.status = 'running';
      const plan = await this.media.plan(record.input, {
        signal: record.controller.signal,
        listFiles: (input) => this.sourceFiles(record, input),
      });
      record.controller.signal.throwIfAborted();
      record.progress.matchedFiles = plan.totalFiles;
      record.phase = 'target';
      const target = await this.target(record, plan);
      record.controller.signal.throwIfAborted();
      const result = await this.media.preview(record.input, { plan, target });
      await writeFile(this.file(record.id, true), JSON.stringify(plan), { mode: 0o600 });
      record.controller.signal.throwIfAborted();
      record.result = { ...result, scanId: record.id, scannedAt: this.now() };
      record.status = 'completed';
      record.phase = 'done';
    } catch (error) {
      record.status = record.controller.signal.aborted
        ? record.interrupted
          ? 'interrupted'
          : 'cancelled'
        : 'failed';
      record.error =
        record.status === 'cancelled' ? '扫描已取消，未创建传输任务。' : safeError(error.message);
      await unlink(this.file(record.id, true)).catch(() => {});
    } finally {
      record.finishedAt = this.now();
      record.expiresAt = this.now() + TTL;
      record.currentPath = '';
      await this.save(record).catch(() => {
        record.status = 'failed';
        record.error = '扫描结果无法保存，请检查数据目录权限。';
      });
    }
  }
  async planForJob(job, controller) {
    const record = {
      controller,
      progress: {
        directoriesDone: 0,
        directoriesFound: 0,
        filesFound: 0,
        bytesFound: 0,
        matchedFiles: 0,
      },
      currentPath: '',
    };
    job.scanProgress = { phase: 'source', progress: record.progress, currentPath: '' };
    return this.media.plan(job, {
      signal: controller.signal,
      listFiles: async (input) => {
        Object.defineProperty(record, 'currentPath', {
          configurable: true,
          get: () => job.scanProgress.currentPath,
          set: (value) => {
            job.scanProgress.currentPath = value;
          },
        });
        return this.sourceFiles(record, input);
      },
    });
  }
  cancel(id) {
    const record = this.get(id);
    if (ACTIVE.has(record.status)) {
      record.status = 'cancelling';
      record.controller.abort(new AppError('扫描已取消。', 409));
    }
    return this.view(record);
  }
  async confirmed(id, input) {
    const record = this.get(id);
    if (record.status !== 'completed') throw new AppError('请等待扫描完成后再确认传输。', 409);
    if (signature(input) !== record.signature)
      throw new AppError('来源、目标或传输规则已变更，请重新扫描。', 409);
    if ((await this.binding(record.input)) !== record.binding)
      throw new AppError('存储连接已变更，请重新扫描。', 409);
    let plan;
    try {
      plan = JSON.parse(await readFile(this.file(id, true), 'utf8'));
    } catch {
      throw new AppError('扫描文件清单已失效，请重新扫描。', 410);
    }
    return {
      mediaPlan: plan,
      scanId: id,
      scannedAt: record.result.scannedAt,
      scanBinding: record.binding,
    };
  }
  async analyzed(id, input, budget = 0) {
    const { mediaPlan } = await this.confirmed(id, input);
    const result = this.get(id).result;
    const oversized = budget ? mediaPlan.files.filter((file) => file.size > budget) : [];
    return {
      ...result,
      oversizedCount: oversized.length,
      oversized: oversized.slice(0, 20).map((file) => ({ path: file.path, size: file.size })),
    };
  }
  async close() {
    this.closed = true;
    for (const record of this.records.values())
      if (ACTIVE.has(record.status)) {
        record.interrupted = true;
        record.controller.abort(new AppError('服务重启，扫描已中断，请重新扫描。', 409));
      }
    await Promise.allSettled([...this.records.values()].map((r) => r.run));
  }
}
