import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, cleanPath, safeError } from './validation.mjs';
import { calendar, usage, exhausted } from './scheduling.mjs';
import { mediaEnabled, normalizeSourcePaths, validateMediaOptions } from './media.mjs';

export const ACTIVE = ['running', 'queued', 'retry_wait', 'waiting_quota', 'blocked'];
export const OP_DEFAULTS = {
  maxJobs: 4,
  maxRetries: 3,
  retryDelaySeconds: 30,
  maxDelaySeconds: 1800,
  healthMinutes: 15,
  autoResume: true,
};
export function operationSettings(input) {
  const value = { ...OP_DEFAULTS, ...input };
  for (const [key, min, max] of [
    ['maxJobs', 1, 8],
    ['maxRetries', 0, 20],
    ['retryDelaySeconds', 1, 3600],
    ['maxDelaySeconds', 1, 86400],
    ['healthMinutes', 1, 1440],
  ]) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max)
      throw new AppError(`${key} 超出允许范围。`);
  }
  if (typeof value.autoResume !== 'boolean' || value.maxDelaySeconds < value.retryDelaySeconds)
    throw new AppError('恢复或重试设置无效。');
  return Object.fromEntries(Object.keys(OP_DEFAULTS).map((key) => [key, value[key]]));
}
export function transferOptions(input = {}) {
  const filters = input.filters || {};
  const rules = (key) => {
    const values = filters[key] || [];
    if (
      !Array.isArray(values) ||
      values.length > 50 ||
      values.some((v) => typeof v !== 'string' || !v || v.length > 512 || /[\x00-\x1f]/.test(v))
    )
      throw new AppError('筛选规则格式不正确。');
    return values;
  };
  const result = { include: rules('include'), exclude: rules('exclude') };
  for (const key of ['minSize', 'maxSize']) {
    result[key] = Number(filters[key] || 0);
    if (!Number.isSafeInteger(result[key]) || result[key] < 0 || result[key] > 1024 ** 5)
      throw new AppError('文件大小筛选值无效。');
  }
  if (result.maxSize && result.minSize > result.maxSize)
    throw new AppError('最小文件大小不能超过最大值。');
  const selections = input.selections || [];
  if (!Array.isArray(selections) || selections.length > 10000)
    throw new AppError('最多选择 10000 项。');
  const selected = selections.map((value) => {
    if (!value || typeof value.isDir !== 'boolean' || !cleanPath(value.path))
      throw new AppError('所选文件路径无效。');
    return { path: cleanPath(value.path), isDir: value.isDir };
  });
  if (selected.length && input.mode === 'sync')
    throw new AppError('勾选部分文件时请使用复制，避免同步删除目标其他文件。');
  const paths = input.sourcePaths ?? [];
  if (
    !Array.isArray(paths) ||
    paths.length > 20 ||
    paths.some((value) => typeof value !== 'string')
  )
    throw new AppError('来源目录最多为 20 个有效路径。');
  const normalized = [...new Set(paths.map((value) => cleanPath(value)))];
  // Keep each source subtree only once, including an explicitly selected remote root.
  const sourcePaths = normalized.filter(
    (value) =>
      !normalized.some((parent) => parent !== value && (!parent || value.startsWith(`${parent}/`))),
  );
  if (sourcePaths.length && selected.length)
    throw new AppError('多个来源目录不能同时使用部分文件勾选，请分别创建任务。');
  if (sourcePaths.length && input.mode === 'sync')
    throw new AppError('多个来源目录请使用复制，避免同步删除其他目录的文件。');
  normalizeSourcePaths({ ...input, sourcePaths });
  return {
    filters: result,
    selections: selected,
    sourcePaths,
    media: validateMediaOptions(input.media),
  };
}
export function rcloneFilter(filters = {}) {
  return {
    IncludeRule: filters.include || [],
    ExcludeRule: filters.exclude || [],
    MinSize: filters.minSize || -1,
    MaxSize: filters.maxSize || -1,
  };
}
export function failureKind(error) {
  if (
    /429|too many requests|rateLimitExceeded|dailyLimitExceeded|rate.limit|限流|频率/i.test(error)
  )
    return 'rate';
  if (
    /401|403|unauthori[sz]ed|invalid.*(?:token|cookie|credential)|(?:token|cookie).*expired|登录失效|未完成登录|认证|授权失效/i.test(
      error,
    )
  )
    return 'auth';
  if (
    /\b50[0-9]\b|timeout|timed out|connection|network|temporar|unexpected EOF|broken pipe|请求超时|无法连接/i.test(
      error,
    )
  )
    return 'network';
  return 'permanent';
}

export class Operations {
  constructor(context) {
    Object.assign(this, context);
    this.state.operations = operationSettings(this.state.operations);
    this.state.remotePolicies ||= {};
    this.state.quotaGroups ||= [];
    this.state.health ||= {};
    this.state.schedules ||= [];
    for (const job of this.state.jobs) {
      job.filters ||= { include: [], exclude: [], minSize: 0, maxSize: 0 };
      job.selections ||= [];
      job.sourcePaths ||= [];
      job.media ||= validateMediaOptions();
      job.files ||= [];
      job.events ||= [];
      if (job.verification?.status === 'running') job.verification.status = 'interrupted';
      if (!job.scheduleId && job.status === 'interrupted') {
        job.status = this.state.operations.autoResume && job.recoverOnStart ? 'queued' : 'paused';
        job.waitReason = '服务重启，等待重新检查剩余文件';
      }
      if (!job.scheduleId && !this.state.operations.autoResume && ACTIVE.includes(job.status))
        job.status = 'paused';
      if (job.scheduleId && job.status === 'interrupted' && job.recoverOnStart) {
        job.status = this.state.operations.autoResume ? 'queued' : 'paused';
        job.waitReason = '服务重启，等待重新检查剩余文件';
      }
    }
    for (const schedule of this.state.schedules) {
      const pending = this.state.jobs.filter(
        (job) =>
          job.scheduleId === schedule.id &&
          (ACTIVE.includes(job.status) || job.status === 'paused'),
      );
      const owner = pending.find((job) => job.id === schedule.runningJobId) || pending.at(-1);
      schedule.runningJobId = owner?.id || null;
      for (const job of pending) {
        if (job === owner) continue;
        job.status = 'stopped';
        delete job.retryAt;
        this.event(job, '服务恢复时发现同一计划的重复任务，已停止重复项');
      }
    }
  }
  event(job, message) {
    job.events ||= [];
    job.events.push({ at: new Date(this.now()).toISOString(), message: safeError(message) });
    job.events = job.events.slice(-200);
  }
  policy(remote) {
    return {
      label: remote === 'local' ? '本地文件' : remote,
      groupId: '',
      maxJobs: this.state.cloudRemotes[remote] ? 1 : 2,
      healthPath: '',
      ...this.state.remotePolicies[remote],
    };
  }
  setPolicy(remote, input) {
    const label = String(input.label || remote).trim();
    if (
      !label ||
      label.length > 80 ||
      !Number.isInteger(input.maxJobs) ||
      input.maxJobs < 1 ||
      input.maxJobs > 8
    )
      throw new AppError('账号显示名或并发数无效。');
    if (input.groupId && !this.state.quotaGroups.some((group) => group.id === input.groupId))
      throw new AppError('共享额度组不存在。');
    this.state.remotePolicies[remote] = {
      label,
      maxJobs: input.maxJobs,
      groupId: input.groupId || '',
      healthPath: cleanPath(input.healthPath || ''),
    };
    return this.policy(remote);
  }
  setGroup(input, id) {
    const name = String(input.name || '').trim();
    const dailyBytes = Number(input.dailyBytes);
    if (
      !name ||
      name.length > 80 ||
      !Number.isSafeInteger(dailyBytes) ||
      dailyBytes <= 0 ||
      dailyBytes > 1024 ** 5
    )
      throw new AppError('请设置额度组名称和有效的每日容量。');
    if (typeof input.timezone !== 'string' || !input.timezone || input.timezone.length > 80)
      throw new AppError('请选择额度组时区。');
    try {
      calendar(this.now(), input.timezone);
    } catch {
      throw new AppError('额度组时区无效。');
    }
    if (!['hard', 'soft'].includes(input.cutoffMode)) throw new AppError('额度停止方式无效。');
    const existing = id ? this.state.quotaGroups.find((group) => group.id === id) : null;
    if (id && !existing) throw new AppError('额度组不存在。', 404);
    if (
      existing &&
      Object.keys(existing.usage || {}).length &&
      existing.timezone !== input.timezone
    )
      throw new AppError('已使用额度组不能更换时区。');
    const group = existing || { id: randomBytes(8).toString('hex'), usage: {} };
    Object.assign(group, {
      name,
      dailyBytes,
      timezone: input.timezone,
      cutoffMode: input.cutoffMode,
    });
    if (!existing) this.state.quotaGroups.push(group);
    return group;
  }
  groups(job) {
    const ids = new Set(
      [job.source.remote, job.destination.remote, job.targetRemote]
        .filter(Boolean)
        .map((remote) => this.policy(remote).groupId)
        .filter(Boolean),
    );
    return this.state.quotaGroups.filter((group) => ids.has(group.id));
  }
  view() {
    return {
      settings: this.state.operations,
      policies: this.state.remotePolicies,
      health: this.state.health,
      groups: this.state.quotaGroups.map((group) => ({
        id: group.id,
        name: group.name,
        dailyBytes: group.dailyBytes,
        timezone: group.timezone,
        cutoffMode: group.cutoffMode,
        today: {
          date: calendar(this.now(), group.timezone).date,
          ...usage(group, calendar(this.now(), group.timezone).date),
        },
      })),
    };
  }
  gate(job) {
    const running = this.state.jobs.filter(
      (item) => item.status === 'running' && item.id !== job.id,
    );
    if (running.length >= this.state.operations.maxJobs)
      return { status: 'queued', reason: '等待全局传输槽位' };
    const driveGate = this.driveGroups?.gate(job, running);
    if (driveGate) return driveGate;
    if (mediaEnabled(job)) {
      const target = cleanPath(job.destination.path);
      if (
        running.some((item) => {
          if (
            !mediaEnabled(item) ||
            (this.driveGroups?.targetKey(item.destination.remote) || item.destination.remote) !==
              (this.driveGroups?.targetKey(job.destination.remote) || job.destination.remote)
          )
            return false;
          const active = cleanPath(item.destination.path);
          return (
            active === target ||
            !active ||
            !target ||
            active.startsWith(`${target}/`) ||
            target.startsWith(`${active}/`)
          );
        })
      )
        return { status: 'queued', reason: '等待目标目录的影视传输完成，避免重复写入' };
    }
    for (const remote of new Set(
      [job.source.remote, job.destination.remote, job.targetRemote].filter(Boolean),
    )) {
      if (
        this.state.jobs.some(
          (item) =>
            item.verification?.status === 'running' &&
            [item.source.remote, item.destination.remote].includes(remote),
        )
      )
        return { status: 'queued', reason: `等待 ${this.policy(remote).label} 完成校验` };
      if (this.state.health[remote]?.status === 'auth_required')
        return { status: 'blocked', reason: `${this.policy(remote).label} 需要重新登录` };
      if (
        running.filter((item) =>
          [item.source.remote, item.destination.remote, item.targetRemote].includes(remote),
        ).length >= this.policy(remote).maxJobs
      )
        return { status: 'queued', reason: `等待 ${this.policy(remote).label} 的传输槽位` };
    }
    for (const group of this.groups(job)) {
      // Serialize jobs sharing a budget so they cannot reserve the same remaining bytes.
      if (running.some((item) => this.groups(item).some((g) => g.id === group.id)))
        return { status: 'queued', reason: `等待共享额度组 ${group.name}` };
      const day = usage(group, calendar(this.now(), group.timezone).date);
      if (day.bytes >= group.dailyBytes || day.outcome === 'bytes_limit')
        return { status: 'waiting_quota', reason: `${group.name} 今日额度已用完，次日继续` };
    }
    return null;
  }
  limits(job, schedule) {
    const scopes = this.groups(job).map((group) => ({
      id: group.id,
      date: calendar(this.now(), group.timezone).date,
      remaining: Math.max(
        0,
        group.dailyBytes - usage(group, calendar(this.now(), group.timezone).date).bytes,
      ),
    }));
    const capacities = this.groups(job).map((group) =>
      Math.max(0, group.dailyBytes - usage(group, calendar(this.now(), group.timezone).date).bytes),
    );
    if (schedule?.dailyBytes)
      capacities.push(
        Math.max(
          0,
          schedule.dailyBytes - usage(schedule, calendar(this.now(), schedule.timezone).date).bytes,
        ),
      );
    job.driveCapacity = this.driveGroups?.capacity(job) ?? null;
    job.driveMaxFileBytes = this.driveGroups?.maxFileBudget(job.destination.remote) || 0;
    if (job.driveCapacity !== null) capacities.push(job.driveCapacity);
    job.quotaScopes = scopes;
    job.sharedAccountedBytes = 0;
    return {
      bytes: capacities.length ? Math.min(...capacities) : 0,
      seconds: schedule?.dailySeconds
        ? Math.max(
            0,
            schedule.dailySeconds -
              usage(schedule, calendar(this.now(), schedule.timezone).date).seconds,
          )
        : 0,
      cutoffMode:
        job.driveCapacity !== null ||
        schedule?.cutoffMode === 'hard' ||
        this.groups(job).some((g) => g.cutoffMode === 'hard')
          ? 'hard'
          : schedule?.cutoffMode || 'soft',
    };
  }
  async filesFor(input) {
    const source = await this.resolveFs(input.source);
    const { filters, selections } = transferOptions(input);
    const data = await this.engine.call(
      'operations/list',
      {
        fs: source.fs,
        remote: '',
        opt: { recurse: true, filesOnly: true, noModTime: true, noMimeType: true },
        _filter: rcloneFilter(filters),
      },
      120000,
    );
    const list = data.list || [];
    if (list.length > 100000) throw new AppError('目录超过 100000 个文件，请选择更小的源目录。');
    return list.filter(
      (file) =>
        !file.IsDir &&
        (!selections.length ||
          selections.some((item) =>
            item.isDir ? file.Path.startsWith(`${item.path}/`) : file.Path === item.path,
          )),
    );
  }
  async prepareFilter(job) {
    const filter = rcloneFilter(job.filters);
    if (job.selections.length) {
      const files = await this.filesFor(job);
      const folder = path.join(this.dataDir, 'manifests');
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const manifest = path.join(folder, `${job.id}.txt`);
      const paths = files.map((file) => cleanPath(file.Path));
      await writeFile(manifest, paths.join('\n') + (paths.length ? '\n' : ''), { mode: 0o600 });
      job.selectedFileCount = paths.length;
      return { FilesFromRaw: [manifest] };
    }
    return filter;
  }
  async analyze(input) {
    const files = await this.filesFor(input);
    const groups = this.groups(input);
    const limits = [
      Number(input.dailyBytes) || 0,
      ...groups.map((group) => group.dailyBytes),
      this.driveGroups?.maxFileBudget(input.destination.remote) || 0,
    ].filter(Boolean);
    const smallest = limits.length ? Math.min(...limits) : 0;
    const oversized = smallest ? files.filter((file) => file.Size > smallest) : [];
    return {
      count: files.length,
      bytes: files.reduce((sum, file) => sum + Math.max(0, file.Size), 0),
      largest: files.reduce((max, file) => Math.max(max, file.Size), 0),
      dailyBytes: smallest,
      oversized: oversized.slice(0, 20).map((file) => ({ path: file.Path, size: file.Size })),
      oversizedCount: oversized.length,
      warning: oversized.length
        ? '部分文件超过每日容量。立即停止可能导致次日重新传输；建议选择完成当前文件后停止。断点续传取决于网盘后端。'
        : '',
    };
  }
  async enqueue(input, schedule, { manual = false, mediaRetryFiles } = {}) {
    await this.transferEndpoints(input);
    const options = transferOptions(input);
    if (
      schedule &&
      (schedule.runningJobId ||
        this.state.jobs.some(
          (job) =>
            job.scheduleId === schedule.id &&
            (ACTIVE.includes(job.status) || job.status === 'paused'),
        ))
    )
      throw new AppError('该计划已有运行或暂停任务。', 409);
    if (this.state.jobs.filter((job) => ACTIVE.includes(job.status)).length >= 500)
      throw new AppError('待执行任务超过 500 个，请先清理任务。', 409);
    const job = {
      id: randomBytes(8).toString('hex'),
      name: String(input.name || '传输任务')
        .trim()
        .slice(0, 80),
      source: { remote: input.source.remote, path: cleanPath(input.source.path) },
      destination: { remote: input.destination.remote, path: cleanPath(input.destination.path) },
      mode: input.mode,
      dryRun: input.dryRun === true,
      confirmDelete: input.confirmDelete === true,
      ...options,
      status: 'queued',
      createdAt: new Date(this.now()).toISOString(),
      stats: {},
      attempts: 0,
      files: [],
      events: [],
      ...(mediaRetryFiles ? { mediaRetryFiles: structuredClone(mediaRetryFiles) } : {}),
      ...(schedule ? { scheduleId: schedule.id, manualScheduleRun: manual } : {}),
    };
    this.state.jobs.unshift(job);
    if (schedule) schedule.runningJobId = job.id;
    this.event(job, '任务已保存到队列');
    await this.save();
    await this.dispatch();
    return job;
  }
  async dispatch() {
    if (this.dispatching) return this.dispatching;
    this.dispatching = this.dispatchQueue();
    try {
      return await this.dispatching;
    } finally {
      this.dispatching = null;
    }
  }
  async dispatchQueue() {
    for (const job of [...this.state.jobs].reverse()) {
      if (!['queued', 'retry_wait', 'waiting_quota', 'blocked'].includes(job.status)) continue;
      if (job.retryAt && job.retryAt > this.now()) continue;
      const schedule = job.scheduleId
        ? this.state.schedules.find((s) => s.id === job.scheduleId)
        : null;
      if (job.scheduleId && !schedule) {
        job.status = 'stopped';
        delete job.retryAt;
        continue;
      }
      if (schedule && !schedule.enabled && !job.manualScheduleRun) {
        job.waitReason = '计划已停用，等待重新启用';
        schedule.runningJobId ||= job.id;
        continue;
      }
      if (schedule && schedule.runningJobId && schedule.runningJobId !== job.id) {
        job.status = 'stopped';
        delete job.retryAt;
        this.event(job, '同一计划已有任务，已停止重复项');
        continue;
      }
      if (schedule) schedule.runningJobId = job.id;
      const gate = this.gate(job);
      if (gate) {
        job.status = gate.status;
        job.waitReason = gate.reason;
        continue;
      }
      if (
        schedule &&
        exhausted(schedule, usage(schedule, calendar(this.now(), schedule.timezone).date))
      ) {
        job.status = 'limited';
        schedule.runningJobId = null;
        delete job.retryAt;
        continue;
      }
      try {
        await this.launch(job, schedule);
        delete job.waitReason;
        delete job.retryAt;
        this.event(job, `开始第 ${job.attempts} 次执行`);
      } catch (error) {
        job.error = safeError(error.message);
        await this.finished(job, schedule, {
          success: false,
          error: job.error,
          endTime: new Date(this.now()).toISOString(),
        });
      }
    }
  }
  account(job, stats) {
    const current = Math.max(job.sharedAccountedBytes || 0, Number(stats.bytes) || 0);
    const delta = current - (job.sharedAccountedBytes || 0);
    this.driveGroups?.accountBytes(job, delta);
    job.transferredBytes = (job.transferredBytes || 0) + delta;
    for (const scope of job.quotaScopes || []) {
      const group = this.state.quotaGroups.find((item) => item.id === scope.id);
      if (group) usage(group, scope.date, true).bytes += delta;
    }
    job.sharedAccountedBytes = current;
  }
  async details(job) {
    const data = await this.engine.call('core/transferred', { group: job.group });
    const seen = new Set(job.files.map((file) => file.key));
    for (const item of data.transferred || []) {
      const key = `${job.attempts}:${item.timestamp}:${item.name}:${item.what}:${item.error || ''}`;
      if (seen.has(key)) continue;
      const timestamp =
        typeof item.timestamp === 'number' ? item.timestamp : Date.parse(item.timestamp);
      job.files.push({
        key,
        path: item.name,
        size: item.size,
        bytes: item.bytes,
        status: item.error
          ? 'failed'
          : item.what === 'deleting'
            ? 'deleted'
            : item.checked
              ? 'skipped'
              : 'completed',
        error: safeError(item.error || ''),
        at: Number.isFinite(timestamp)
          ? new Date(timestamp).toISOString()
          : new Date(this.now()).toISOString(),
        attempt: job.attempts,
      });
      seen.add(key);
    }
    if (job.files.length > 10000) {
      job.files = job.files.slice(-10000);
      job.detailsTruncated = true;
    }
  }
  rollover(job) {
    return (job.quotaScopes || []).some((scope) => {
      const group = this.state.quotaGroups.find((g) => g.id === scope.id);
      return group && calendar(this.now(), group.timezone).date !== scope.date;
    });
  }
  async finished(job, schedule, status) {
    if (['running', 'queued', 'retry_wait', 'blocked', 'waiting_quota'].includes(job.status))
      job.status = status.success ? 'completed' : 'failed';
    const error = safeError(status.error || job.error || '');
    const kind = failureKind(error);
    const sharedExhausted = this.groups(job).some((group) => {
      const day = usage(group, calendar(this.now(), group.timezone).date);
      return day.bytes >= group.dailyBytes;
    });
    if (
      !status.success &&
      this.driveGroups?.rotate(
        job,
        error,
        sharedExhausted ||
          (schedule &&
            exhausted(schedule, usage(schedule, calendar(this.now(), schedule.timezone).date))),
      )
    ) {
      this.event(job, job.waitReason);
      delete job.retryAt;
      if (schedule) {
        schedule.runningJobId = job.id;
        usage(schedule, job.quotaDate, true).outcome = 'running';
      }
      await this.notify('quota', job);
      return;
    }
    if (job.stopReason === 'pause') job.status = 'paused';
    else if (job.stopReason === 'shutdown')
      job.status = schedule
        ? 'interrupted'
        : this.state.operations.autoResume
          ? 'queued'
          : 'paused';
    else if (job.stopping && !['rollover', 'quota_rollover'].includes(job.stopReason))
      job.status = 'stopped';
    else if (
      /max transfer limit|transfer limit reached/i.test(error) ||
      job.stopReason === 'quota_rollover'
    ) {
      for (const scope of job.quotaScopes || []) {
        const group = this.state.quotaGroups.find((g) => g.id === scope.id);
        if (group && job.stopReason !== 'quota_rollover' && scope.remaining === job.limits?.bytes)
          usage(group, scope.date, true).outcome = 'bytes_limit';
      }
      if (
        job.quotaScopes?.length ||
        (job.driveCapacity !== null && job.driveCapacity !== undefined)
      )
        job.status = schedule ? 'limited' : 'waiting_quota';
      await this.notify('quota', job);
    } else if (!status.success && !job.stopping && kind === 'auth') {
      job.status = 'blocked';
      job.waitReason = '登录失效，请检查源和目标账号并重新授权';
      for (const remote of [job.source.remote, job.targetRemote || job.destination.remote].filter(
        (r) => r !== 'local',
      ))
        this.state.health[remote] = {
          status: 'auth_required',
          error,
          checkedAt: new Date(this.now()).toISOString(),
        };
      await this.notify('auth', job);
    } else if (
      !status.success &&
      !job.stopping &&
      ['rate', 'network'].includes(kind) &&
      (job.retries || 0) < this.state.operations.maxRetries
    ) {
      job.retries = (job.retries || 0) + 1;
      job.status = 'retry_wait';
      job.retryAt =
        this.now() +
        Math.min(
          this.state.operations.maxDelaySeconds,
          this.state.operations.retryDelaySeconds * 2 ** (job.retries - 1),
        ) *
          1000;
      job.waitReason = kind === 'rate' ? '网盘限流，等待重试' : '网络异常，等待重试';
    }
    if (schedule && ['retry_wait', 'blocked', 'paused'].includes(job.status)) {
      schedule.runningJobId = job.id;
      usage(schedule, job.quotaDate || calendar(this.now(), schedule.timezone).date, true).outcome =
        'running';
    } else if (schedule && job.status === 'limited' && job.quotaScopes?.length)
      usage(schedule, job.quotaDate, true).outcome = 'shared_limit';
    if (job.status !== 'retry_wait') delete job.retryAt;
    if (['completed', 'failed', 'stopped', 'limited'].includes(job.status)) delete job.waitReason;
    if (schedule && !['retry_wait', 'blocked', 'paused'].includes(job.status)) {
      if (schedule.runningJobId === job.id) schedule.runningJobId = null;
      const day = usage(
        schedule,
        job.quotaDate || calendar(this.now(), schedule.timezone).date,
        true,
      );
      if (job.status === 'interrupted') day.outcome = 'interrupted';
      if (['completed', 'failed', 'stopped'].includes(job.status)) {
        day.outcome = job.status === 'stopped' ? 'paused' : job.status;
        schedule.lastFinishedAt = status.endTime || new Date(this.now()).toISOString();
        schedule.error = job.status === 'failed' ? error : '';
        if (schedule.scanIntervalMinutes && ['completed', 'failed'].includes(job.status)) {
          day.nextScanAt = this.now() + schedule.scanIntervalMinutes * 60000;
          schedule.nextScanAt = day.nextScanAt;
        }
      }
    }
    this.event(job, job.waitReason || `执行结束：${job.status}${error ? `；${error}` : ''}`);
    if (['completed', 'failed'].includes(job.status)) await this.notify(job.status, job);
    if (job.status === 'limited') await this.notify('quota', job);
  }
  async healthCheck(remote) {
    try {
      if (this.state.cloudRemotes[remote]) {
        const view = await this.cloud.read(remote);
        if (view.phase !== 'ready') throw new AppError('网盘登录失效或尚未完成授权。');
      }
      const source = await this.resolveFs({ remote, path: this.policy(remote).healthPath });
      await this.engine.call(
        'operations/list',
        { fs: source.fs, remote: '', opt: { dirsOnly: true, noModTime: true, noMimeType: true } },
        15000,
      );
      this.state.health[remote] = {
        status: 'healthy',
        checkedAt: new Date(this.now()).toISOString(),
        error: '',
      };
    } catch (error) {
      const status = failureKind(error.message) === 'auth' ? 'auth_required' : 'unavailable';
      const previous = this.state.health[remote]?.status;
      this.state.health[remote] = {
        status,
        checkedAt: new Date(this.now()).toISOString(),
        error: safeError(error.message),
      };
      if (status === 'auth_required' && previous !== status)
        await this.notify('auth', { name: this.policy(remote).label, id: remote });
    }
    await this.save();
    return this.state.health[remote];
  }
}
