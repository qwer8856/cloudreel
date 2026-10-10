import express from 'express';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  copyFile,
  readdir,
  unlink,
  chmod,
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Engine } from './engine.mjs';
import { OpenListConnector, CLOUD_TYPES } from './openlist.mjs';
import { Operations, ACTIVE, operationSettings, transferOptions } from './operations.mjs';
import { Notifications } from './notifications.mjs';
import { Backups } from './backup.mjs';
import { MediaRunner } from './media-runner.mjs';
import { MediaScans } from './media-scans.mjs';
import { mediaEnabled } from './media.mjs';
import { openAuthentication } from './auth.mjs';
import { Direct115 } from './direct115.mjs';
import { DriveGroups } from './drive-groups.mjs';
import {
  account,
  calendar,
  due,
  exhausted,
  finishSchedule,
  scheduleView,
  usage,
  validateSchedule,
} from './scheduling.mjs';
import {
  AppError,
  remoteName,
  cleanPath,
  localPath,
  validateSettings,
  sanitizeRemote,
  secretOption,
  safeError,
} from './validation.mjs';

const DEFAULTS = { transfers: 4, checkers: 8, retries: 3, bandwidth: '' };
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function createPanel(options = {}) {
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  const env = { ...process.env, ...options };
  const host = env.HOST || '127.0.0.1';
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const dataDir = path.resolve(env.DATA_DIR || './data/panel');
  const localRoot = path.resolve(env.LOCAL_ROOT || './data/files');
  const config = path.resolve(env.RCLONE_CONFIG || './data/config/rclone.conf');
  await Promise.all([
    mkdir(dataDir, { recursive: true, mode: 0o700 }),
    mkdir(localRoot, { recursive: true }),
  ]);
  const authentication = await openAuthentication(
    dataDir,
    env.PANEL_PASSWORD || '',
    loopback ? 1 : 12,
  );
  const setupRequired = () => !loopback && !authentication.configured;
  const stateFile = path.join(dataDir, 'state.json');
  let state = { settings: { ...DEFAULTS }, jobs: [], pending: {}, schedules: [] };
  try {
    state = { ...state, ...JSON.parse(await readFile(stateFile, 'utf8')) };
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new Error('任务记录文件无法读取，请检查 DATA_DIR/state.json。');
  }
  state.settings = validateSettings(state.settings);
  for (const job of state.jobs)
    if (job.status === 'running') {
      job.status = 'interrupted';
      job.recoverOnStart = true;
      job.error = '服务重启，任务已中断。';
      job.finishedAt = new Date().toISOString();
    }
  for (const schedule of state.schedules) {
    if (schedule.runningJobId) {
      const job = state.jobs.find((item) => item.id === schedule.runningJobId);
      if (job?.quotaDate) usage(schedule, job.quotaDate, true).outcome = 'interrupted';
      if (
        !job ||
        (!ACTIVE.includes(job.status) &&
          job.status !== 'paused' &&
          !(job.status === 'interrupted' && job.recoverOnStart))
      )
        schedule.runningJobId = null;
    }
  }
  let writeQueue = Promise.resolve();
  async function save() {
    const payload = JSON.stringify(state, null, 2);
    const operation = writeQueue
      .catch(() => {})
      .then(async () => {
        await writeFile(`${stateFile}.tmp`, payload, { mode: 0o600 });
        await rename(`${stateFile}.tmp`, stateFile);
      });
    writeQueue = operation;
    return operation;
  }
  await save();
  const engine = new Engine({ binary: env.RCLONE_BIN || 'rclone', config });
  await engine.start();
  if (engine.ready) await engine.call('core/bwlimit', { rate: state.settings.bandwidth || 'off' });

  let mutationQueue = Promise.resolve();
  function serialize(action) {
    const next = mutationQueue.catch(() => {}).then(action);
    mutationQueue = next;
    return next;
  }
  async function backup() {
    const folder = path.join(dataDir, 'backups');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    try {
      const target = path.join(
        folder,
        `rclone-${Date.now()}-${randomBytes(3).toString('hex')}.conf`,
      );
      await copyFile(config, target);
      await chmod(target, 0o600);
      const files = (await readdir(folder))
        .filter((name) => /^rclone-\d+-[a-f0-9]+\.conf$/.test(name))
        .sort();
      for (const name of files.slice(0, -10)) await unlink(path.join(folder, name));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  async function dump() {
    return engine.call('config/dump');
  }
  const cloudRecord = (name) =>
    Object.hasOwn(state.cloudRemotes, name) ? state.cloudRemotes[name] : undefined;
  async function remotes() {
    const [configs, providers] = await Promise.all([dump(), engine.providers()]);
    const list = Object.entries(configs)
      .filter(([name]) => !cloudRecord(name))
      .map(([name, config]) => ({
        ...sanitizeRemote(
          name,
          config,
          providers.find((provider) => provider.Name === config.type),
          state.pending[name],
        ),
        teamDriveConfigured: config.type === 'drive' && Boolean(config.team_drive),
      }));
    return [
      ...list,
      ...Object.values(state.cloudRemotes).map((record) => cloud.remoteView(record)),
      ...Object.values(state.direct115Remotes || {}).map((record) => direct115.view(record)),
      ...(state.driveGroups || []).map((group) => driveGroups.remoteView(group)),
    ].map((remote) => ({
      ...remote,
      accountLabel: operations.policy(remote.name).label,
      accountPolicy: operations.policy(remote.name),
      health: state.health[remote.name] || null,
    }));
  }
  const cloud = new OpenListConnector({ state, save, engine, backup, env });
  const direct115 = new Direct115({ state, save, now: clock, ...options.direct115Options });
  await direct115.start();
  const driveGroups = new DriveGroups({
    state,
    save,
    engine,
    now: clock,
    ...options.driveGroupOptions,
  });
  const notifications = new Notifications({ state, save, now: clock });
  const operations = new Operations({
    state,
    save,
    engine,
    cloud,
    driveGroups,
    dataDir,
    now: clock,
    resolveFs,
    transferEndpoints,
    launch: (job, schedule) => launchJob(job, schedule, job),
    notify: (event, job) => {
      if (
        event === 'completed' &&
        mediaEnabled(job) &&
        job.scheduleId &&
        state.schedules.find((item) => item.id === job.scheduleId)?.scanIntervalMinutes &&
        !job.files?.some((file) => file.status === 'completed')
      )
        return;
      return notifications.enqueue(event, job);
    },
  });
  const backups = new Backups({ state, save, cloud, direct115, engine, config, dataDir });
  const media = new MediaRunner({
    engine,
    resolveFs,
    listFiles: (input) => operations.filesFor(input),
    settings: () => ({
      Transfers: 1,
      Checkers: state.settings.checkers,
      Retries: state.settings.retries,
    }),
  });
  const scans = new MediaScans({
    engine,
    media,
    resolveFs,
    dataDir,
    now: clock,
    binding: async (input) => {
      const configs = await dump();
      const connections = [input.source.remote, input.destination.remote].map((name) => {
        const group = driveGroups.record(name);
        const members = group?.members.map((member) => member.remote) || [name];
        return {
          name,
          localRoot: members.some(
            (member) => member === 'local' || configs[member]?.type === 'local',
          )
            ? localRoot
            : undefined,
          direct: direct115.record(name),
          cloud: cloudRecord(name),
          group: group ? { name, members } : undefined,
          configs: members.map((member) => {
            const config = { ...configs[member] };
            if (config.type === 'drive' && config.token) {
              try {
                config.token = JSON.parse(config.token).refresh_token || config.token;
              } catch {}
            }
            return config;
          }),
        };
      });
      return createHash('sha256').update(JSON.stringify(connections)).digest('hex');
    },
  });
  await scans.init();
  media.backgroundPlan = (job, controller) => scans.planForJob(job, controller);
  const verificationTasks = new Set();
  await save();
  function freeRemote(name, schedules = false) {
    if (scans.uses(name)) throw new AppError('该存储仍在扫描，请先完成或取消扫描。', 409);
    if (driveGroups.member(name))
      throw new AppError('该账号属于 Google group，请先从 group 移除后再修改或删除连接。', 409);
    if (
      state.jobs.some(
        (job) =>
          (job.status === 'running' ||
            job.verification?.status === 'running' ||
            (schedules && (ACTIVE.includes(job.status) || job.status === 'paused'))) &&
          [job.source.remote, job.destination.remote].includes(name),
      )
    )
      throw new AppError('该存储仍有运行任务，请先停止任务。', 409);
    if (
      schedules &&
      state.schedules.some((schedule) =>
        [schedule.source.remote, schedule.destination.remote].includes(name),
      )
    )
      throw new AppError('该存储被计划任务引用，请先调整或删除相关计划。', 409);
    if (
      !schedules &&
      state.schedules.some(
        (schedule) =>
          schedule.enabled && [schedule.source.remote, schedule.destination.remote].includes(name),
      )
    )
      throw new AppError('请先停用使用此存储的计划，再修改连接。', 409);
  }
  function question(data) {
    if (!data.State || !data.Option) return null;
    const option = data.Option;
    return {
      state: data.State,
      error: safeError(data.Error || ''),
      option: {
        name: option.Name,
        help: option.Help,
        required: option.Required,
        password: secretOption(option),
        default: option.DefaultStr ?? String(option.Default ?? ''),
        type: option.Type,
        examples: (option.Examples ?? []).map((example) => ({
          value: example.Value,
          help: example.Help,
        })),
      },
    };
  }
  async function configParameters(type, input) {
    const provider = (await engine.providers()).find((provider) => provider.Name === type);
    if (!provider) throw new AppError('不支持的存储类型。');
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new AppError('配置字段格式不正确。');
    const allowed = new Set([...provider.Options.map((option) => option.Name), 'description']);
    const parameters = Object.create(null);
    for (const [key, value] of Object.entries(input)) {
      if (!allowed.has(key)) throw new AppError(`未知配置字段：${key}`);
      if (!['string', 'number', 'boolean'].includes(typeof value) || String(value).length > 65536)
        throw new AppError(`配置字段 ${key} 格式不正确。`);
      parameters[key] = String(value);
    }
    return parameters;
  }
  async function requireRemote(name) {
    if (direct115.record(name)) return { type: 'direct-115' };
    if (driveGroups.record(name)) return { type: 'drive-group' };
    const configs = await dump();
    if (!Object.hasOwn(configs, name)) throw new AppError('存储配置不存在。', 404);
    if (cloudRecord(name)) cloud.assertConfig(cloudRecord(name), configs[name]);
    return configs[name];
  }
  async function resolveFs(endpoint, job) {
    if (!endpoint || typeof endpoint.remote !== 'string') throw new AppError('请选择存储。');
    const relative = cleanPath(endpoint.path);
    if (direct115.record(endpoint.remote))
      return { fs: direct115.fs(endpoint.remote, relative), key: endpoint.remote, path: relative };
    if (driveGroups.record(endpoint.remote)) {
      const target = await resolveFs(driveGroups.endpoint(endpoint, job));
      return { ...target, key: driveGroups.targetKey(endpoint.remote) };
    }
    if (
      cloudRecord(endpoint.remote)?.phase !== undefined &&
      cloudRecord(endpoint.remote).phase !== 'ready'
    )
      throw new AppError('该网盘尚未完成登录，请先编辑连接并完成授权。');
    const config =
      endpoint.remote === 'local' ? { type: 'local' } : await requireRemote(endpoint.remote);
    if (config.type === 'local') {
      const absolute = await localPath(localRoot, relative);
      return {
        fs:
          endpoint.remote === 'local'
            ? absolute
            : `${endpoint.remote}:${absolute.replaceAll('\\', '/')}`,
        key: 'local',
        path: relative,
      };
    }
    return {
      fs: `${endpoint.remote}${driveGroups.member(endpoint.remote) ? ',stop_on_upload_limit=true' : ''}:${relative}`,
      key: driveGroups.targetKey(endpoint.remote),
      path: relative,
    };
  }

  async function transferEndpoints(input) {
    const validated = transferOptions(input);
    if (!['copy', 'sync'].includes(input.mode)) throw new AppError('请选择复制或同步模式。');
    if (mediaEnabled(input) && input.mode !== 'copy')
      throw new AppError('影视归档和多目录传输仅支持复制，来源文件会保留。');
    if (input.mode === 'sync' && input.dryRun !== true && input.confirmDelete !== true)
      throw new AppError('同步会删除目标多余文件，请确认后再运行。');
    const target = cloudRecord(input.destination?.remote);
    if (direct115.record(input.destination?.remote))
      throw new AppError('115 直接连接暂仅支持读取，请选择其他上传目标。');
    if (driveGroups.record(input.destination?.remote) && input.mode !== 'copy')
      throw new AppError('Google group 仅支持复制，请选择复制模式。');
    if (target?.capabilities?.upload === false) throw new AppError('目标网盘驱动不支持上传。');
    if (input.mode === 'sync' && target?.capabilities?.overwrite === false)
      throw new AppError('光鸭不支持同名覆盖，作为目标时请使用复制；已有同名文件会自动跳过。');
    const [source, destination] = await Promise.all([
      resolveFs(input.source),
      resolveFs(input.destination, input),
    ]);
    const overlaps = (a, b) => a === b || !a || b.startsWith(`${a}/`);
    if (
      source.key === destination.key &&
      (overlaps(source.path, destination.path) || overlaps(destination.path, source.path))
    )
      throw new AppError('同一存储的源目录和目标目录不能重合或相互嵌套。');
    for (const path of validated.sourcePaths) {
      const additional = await resolveFs({ remote: input.source.remote, path });
      if (
        additional.key === destination.key &&
        (overlaps(additional.path, destination.path) || overlaps(destination.path, additional.path))
      )
        throw new AppError('来源目录与目标目录不能重合或互相包含。');
    }
    return { source, destination };
  }

  async function startJob(input, schedule = null, options = {}) {
    return operations.enqueue(input, schedule, options);
  }
  async function launchJob(input, schedule = null, queued = null) {
    if (queued?.scanBinding && (await scans.binding(queued)) !== queued.scanBinding)
      throw new AppError('存储连接已变更，请重新扫描后创建传输任务。', 409);
    const { source, destination } = await transferEndpoints(input);
    const dryRun = input.dryRun === true;
    const id = queued?.id || randomBytes(8).toString('hex');
    const group = `studio/${id}/${(queued?.attempts || 0) + 1}`;
    const local = schedule ? calendar(clock(), schedule.timezone) : null;
    const day = schedule ? usage(schedule, local.date, true) : null;
    const limits = operations.limits(queued || input, schedule);
    const mediaMode = mediaEnabled(input);
    if (
      !mediaMode &&
      !dryRun &&
      input.driveMaxFileBytes &&
      (await operations.filesFor(input)).some((file) => file.Size > input.driveMaxFileBytes)
    )
      throw new AppError(
        '文件超过 Google group 所有账号的单次预算，请提高账号预算或调整来源文件。',
      );
    const filter = mediaMode ? null : await operations.prepareFilter(queued || input);
    const createdAt = new Date().toISOString();
    const result = mediaMode
      ? { jobid: null }
      : await engine.call(`sync/${input.mode}`, {
          srcFs: source.fs,
          dstFs: destination.fs,
          // Let each upload create its parents; do not pre-create the source tree.
          createEmptySrcDirs: false,
          _async: true,
          _group: group,
          _filter: filter,
          _config: {
            Transfers: state.settings.transfers,
            Checkers: state.settings.checkers,
            Retries: state.settings.retries,
            DryRun: dryRun,
            ...(cloudRecord(input.source.remote) ||
            cloudRecord(input.destination.remote) ||
            driveGroups.record(input.destination.remote) ||
            driveGroups.member(input.destination.remote)
              ? { DisableFeatures: ['Copy', 'Move'] }
              : {}),
            ...(cloudRecord(input.destination.remote)?.capabilities?.overwrite === false
              ? { IgnoreExisting: true }
              : {}),
            ...(schedule || limits.bytes
              ? {
                  MaxTransfer: limits.bytes || -1,
                  MaxDuration: limits.seconds ? `${limits.seconds}s` : '0s',
                  CutoffMode: limits.cutoffMode.toUpperCase(),
                }
              : {}),
          },
        });
    const job = {
      id,
      jobId: result.jobid,
      group,
      name: String(input.name || `${input.mode === 'copy' ? '复制' : '同步'}任务`)
        .trim()
        .slice(0, 80),
      source: { remote: input.source.remote, path: cleanPath(input.source.path) },
      destination: { remote: input.destination.remote, path: cleanPath(input.destination.path) },
      mode: input.mode,
      dryRun,
      status: 'running',
      createdAt,
      startedAt: createdAt,
      attempts: (queued?.attempts || 0) + 1,
      limits,
      stats: {},
      ...(schedule
        ? {
            scheduleId: schedule.id,
            quotaDate: local.date,
            limits,
            accountedBytes: 0,
            accountedSeconds: 0,
          }
        : {}),
    };
    if (queued) {
      const originalCreatedAt = queued.createdAt;
      Object.assign(queued, job, {
        createdAt: originalCreatedAt,
        stopping: false,
        stopReason: null,
        error: '',
      });
      delete queued.finishedAt;
      delete queued.reason;
      delete queued.rawError;
    } else state.jobs.unshift(job);
    state.jobs = [
      ...state.jobs.filter((item) => ACTIVE.includes(item.status) || item.status === 'paused'),
      ...state.jobs
        .filter((item) => !ACTIVE.includes(item.status) && item.status !== 'paused')
        .slice(0, 200),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (schedule) {
      schedule.runningJobId = id;
      schedule.lastJobId = id;
      schedule.lastStartedAt = createdAt;
      schedule.error = '';
      day.outcome = 'running';
    }
    const launched = queued || job;
    if (mediaMode) await media.start(launched);
    return launched;
  }

  function findSchedule(id) {
    const schedule = state.schedules.find((item) => item.id === id);
    if (!schedule) throw new AppError('计划任务不存在。', 404);
    return schedule;
  }
  async function runSchedule(schedule, manual = false) {
    if (schedule.runningJobId) throw new AppError('该计划已有运行任务。', 409);
    const day = usage(schedule, calendar(clock(), schedule.timezone).date);
    if (exhausted(schedule, day)) throw new AppError('今日额度或时长已用完，请等待次日。', 409);
    return startJob(schedule, schedule, { manual });
  }
  async function stopJob(job, reason = 'user') {
    if (job.jobId !== null && job.jobId !== undefined)
      await engine.call('job/stop', { jobid: job.jobId });
    job.stopping = true;
    job.stopReason = reason;
    media.cancelPreparation(job.id);
  }

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (
      loopback &&
      !authentication.configured &&
      !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.get('host') || '')
    )
      return res.status(403).json({ error: '本机模式仅允许通过 localhost 访问。' });
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (!req.is('application/json')) return res.status(415).json({ error: '请使用 JSON 请求。' });
      const origin = req.get('origin');
      if (origin) {
        try {
          if (new URL(origin).host !== req.get('host')) throw new Error();
        } catch {
          return res.status(403).json({ error: '请求来源无效。' });
        }
      }
    }
    next();
  });
  app.use(
    express.json({
      limit: '512kb',
      type: (req) => req.is('application/json') && !req.path.startsWith('/api/backups'),
    }),
  );
  const sessions = new Map();
  const attempts = new Map();
  const sessionDuration = 12 * 60 * 60 * 1000;
  const cookieSecure = (req) =>
    env.COOKIE_SECURE === 'true' ||
    (env.COOKIE_SECURE !== 'false' &&
      (req.secure || req.get('x-forwarded-proto')?.toLowerCase() === 'https'));
  function token(req) {
    const value = (req.get('cookie') || '')
      .split(';')
      .find((item) => item.trim().startsWith('studio_session='));
    return value?.trim().slice('studio_session='.length) || '';
  }
  function authenticated(req) {
    if (setupRequired()) return false;
    if (!authentication.configured) return true;
    const expires = sessions.get(token(req));
    return Boolean(expires && expires > Date.now());
  }
  app.get('/api/session', (req, res) =>
    res.json({
      authenticated: authenticated(req),
      passwordRequired: authentication.configured || setupRequired(),
      setupRequired: setupRequired(),
    }),
  );
  let authQueue = Promise.resolve();
  function serializeAuthentication(action) {
    const next = authQueue.catch(() => {}).then(action);
    authQueue = next;
    return next;
  }
  function limitAuthentication(req) {
    const key = req.ip;
    const now = Date.now();
    const record = attempts.get(key) || { count: 0, until: now + 5 * 60 * 1000 };
    if (record.until < now) {
      record.count = 0;
      record.until = now + 5 * 60 * 1000;
    }
    if (record.count >= 10) throw new AppError('登录尝试过多，请在 5 分钟后重试。', 429);
    record.count++;
    attempts.set(key, record);
  }
  function createSession(req, res) {
    const now = Date.now();
    for (const [key, expires] of sessions) if (expires < now) sessions.delete(key);
    const id = randomBytes(32).toString('hex');
    sessions.set(id, now + sessionDuration);
    res.cookie('studio_session', id, {
      httpOnly: true,
      sameSite: 'strict',
      secure: cookieSecure(req),
      maxAge: sessionDuration,
      path: '/',
    });
    res.json({ authenticated: true });
  }
  app.post('/api/setup', async (req, res) => {
    await serializeAuthentication(async () => {
      if (authentication.configured) throw new AppError('面板已完成初始化，请直接登录。', 409);
      limitAuthentication(req);
      await authentication.replace(req.body?.password);
      attempts.delete(req.ip);
      createSession(req, res);
    });
  });
  app.post('/api/login', async (req, res) => {
    await serializeAuthentication(async () => {
      limitAuthentication(req);
      const localWithoutPassword =
        loopback && !authentication.configured && req.body?.password === '';
      if (!localWithoutPassword && !(await authentication.verify(req.body?.password)))
        throw new AppError(setupRequired() ? '请先设置面板密码。' : '面板密码不正确。', 401);
      attempts.delete(req.ip);
      createSession(req, res);
    });
  });
  function requireLogin(res) {
    return res.status(401).json({ error: '请先登录面板。', code: 'AUTH_REQUIRED' });
  }
  app.use('/api', (req, res, next) => (authenticated(req) ? next() : requireLogin(res)));
  app.use('/api/backups', express.json({ limit: '96mb' }));
  app.put('/api/password', async (req, res) => {
    await serializeAuthentication(async () => {
      // A password change may have invalidated this request while it was queued.
      if (!authenticated(req)) return requireLogin(res);
      limitAuthentication(req);
      if (!(await authentication.verify(req.body?.currentPassword)))
        throw new AppError('当前面板密码不正确。', 401);
      await authentication.replace(req.body?.password);
      attempts.delete(req.ip);
      sessions.clear();
      createSession(req, res);
    });
  });
  app.post('/api/logout', (req, res) => {
    sessions.delete(token(req));
    res.clearCookie('studio_session', { path: '/', secure: cookieSecure(req), sameSite: 'strict' });
    res.json({ ok: true });
  });
  app.get('/api/status', async (req, res) => {
    const stats = engine.ready ? await engine.call('core/stats') : null;
    res.json({
      available: engine.ready,
      error: engine.error,
      version: engine.version?.version || null,
      uptime: Math.floor(process.uptime()),
      localRoot,
      configPath: config,
      stats: stats && { ...stats, lastError: safeError(stats.lastError || '') },
    });
  });
  app.get('/api/providers', async (req, res) => {
    const providers = (await engine.providers())
      .filter((provider) => !provider.Hide)
      .map((provider) => ({
        name: provider.Name,
        description: provider.Description,
        options: provider.Options.filter((option) => !(option.Hide & 1)).map((option) => ({
          name: option.Name,
          help: option.Help,
          default: option.DefaultStr,
          required: option.Required,
          password: secretOption(option),
          advanced: option.Advanced,
          type: option.Type,
          provider: option.Provider,
          exclusive: option.Exclusive,
          examples: (option.Examples ?? []).map((example) => ({
            value: example.Value,
            help: example.Help,
            provider: example.Provider,
          })),
        })),
      }));
    res.json([
      ...CLOUD_TYPES.map((name) => ({
        name,
        description: '通过 OpenList 连接，支持网盘互传和每日计划',
        managed: true,
        options: [],
      })),
      {
        name: 'drive-group',
        description: '同一 Google 团队盘的多个账号，独立计量并自动切换',
        managed: true,
        options: [],
      },
      ...providers,
    ]);
  });
  app.get('/api/openlist', (req, res) => res.json(cloud.configView()));
  app.put('/api/openlist', async (req, res) =>
    res.json(
      await serialize(async () => {
        for (const name of Object.keys(state.cloudRemotes)) freeRemote(name);
        return cloud.configure(req.body);
      }),
    ),
  );
  app.post('/api/openlist/test', async (req, res) => res.json(await cloud.check()));
  const nameExists = async (name) =>
    cloudRecord(name) ||
    direct115.record(name) ||
    driveGroups.record(name) ||
    Object.hasOwn(await dump(), name);
  app.post('/api/direct115/qr', async (req, res) =>
    res.json(await direct115.startQr(req.body.device)),
  );
  app.get('/api/direct115/qr/:id/image', async (req, res) => {
    const image = await direct115.qrImage(req.params.id);
    res.set('Cache-Control', 'no-store').type(image.type).send(image.body);
  });
  app.get('/api/direct115/qr/:id', async (req, res) =>
    res.json(await direct115.qrStatus(req.params.id)),
  );
  app.delete('/api/direct115/qr/:id', (req, res) => {
    direct115.qr.delete(req.params.id);
    res.json({ ok: true });
  });
  app.get('/api/direct115/:name', (req, res) => {
    const record = direct115.record(req.params.name);
    if (!record) throw new AppError('115 连接不存在。', 404);
    res.json(direct115.view(record));
  });
  app.post('/api/direct115', async (req, res) =>
    res.json(
      await serialize(async () => {
        const name = remoteName(req.body.name);
        if (await nameExists(name)) throw new AppError('该存储名称已存在。', 409);
        return direct115.write(req.body);
      }),
    ),
  );
  app.put('/api/direct115/:name', async (req, res) =>
    res.json(
      await serialize(async () => {
        freeRemote(req.params.name);
        const result = await direct115.write(req.body, req.params.name);
        delete state.health[req.params.name];
        await save();
        return result;
      }),
    ),
  );
  app.get('/api/drive-groups', (req, res) =>
    res.json((state.driveGroups || []).map((group) => driveGroups.view(group))),
  );
  app.post('/api/drive-groups', async (req, res) =>
    res.json(
      await serialize(async () => {
        const name = remoteName(req.body.name);
        if (await nameExists(name)) throw new AppError('该存储名称已存在。', 409);
        return driveGroups.write(req.body);
      }),
    ),
  );
  app.put('/api/drive-groups/:name', async (req, res) =>
    res.json(
      await serialize(async () => {
        freeRemote(req.params.name);
        const current = driveGroups.record(req.params.name);
        if (
          current &&
          state.jobs.some(
            (job) =>
              job.status === 'running' &&
              current.members.some((member) =>
                [job.source.remote, job.destination.remote, job.targetRemote].includes(
                  member.remote,
                ),
              ),
          )
        )
          throw new AppError('请先暂停 group 成员的运行任务。', 409);
        const result = await driveGroups.write(req.body, req.params.name);
        delete state.health[req.params.name];
        await save();
        return result;
      }),
    ),
  );
  app.get('/api/cloud-remotes/:name', async (req, res) =>
    res.json(await serialize(() => cloud.read(req.params.name))),
  );
  app.post('/api/cloud-remotes', async (req, res) =>
    res.json(
      await serialize(async () => {
        const name = remoteName(req.body.name);
        if (await nameExists(name)) throw new AppError('该存储名称已存在。', 409);
        return cloud.write(req.body);
      }),
    ),
  );
  app.put('/api/cloud-remotes/:name', async (req, res) =>
    res.json(
      await serialize(async () => {
        freeRemote(req.params.name);
        return cloud.write(req.body, req.params.name);
      }),
    ),
  );
  app.get('/api/remotes', async (req, res) => res.json(await remotes()));
  app.post('/api/remotes', async (req, res) =>
    res.json(
      await serialize(async () => {
        const name = remoteName(req.body.name);
        const type = req.body.type;
        const configs = await dump();
        if (Object.hasOwn(configs, name) || (await nameExists(name)))
          throw new AppError('该存储名称已存在。', 409);
        const parameters = await configParameters(type, req.body.parameters);
        await backup();
        const output = await engine.call('config/create', {
          name,
          type,
          parameters: { ...parameters, config_is_local: 'false' },
          opt: { nonInteractive: true, obscure: true },
        });
        const pending = question(output);
        if (pending) state.pending[name] = pending;
        else delete state.pending[name];
        await save();
        return { name, pending };
      }),
    ),
  );
  app.put('/api/remotes/:name', async (req, res) =>
    res.json(
      await serialize(async () => {
        const name = req.params.name;
        if (cloudRecord(name) || direct115.record(name) || driveGroups.record(name))
          throw new AppError('请使用专用登录或 group 表单修改此连接。');
        freeRemote(name);
        const config = await requireRemote(name);
        const parameters = await configParameters(config.type, req.body.parameters);
        await backup();
        const output = await engine.call('config/update', {
          name,
          parameters: { ...parameters, config_is_local: 'false' },
          opt: { nonInteractive: true, obscure: true },
        });
        const pending = question(output);
        if (pending) state.pending[name] = pending;
        else delete state.pending[name];
        await save();
        return { name, pending };
      }),
    ),
  );
  app.post('/api/remotes/:name/continue', async (req, res) =>
    res.json(
      await serialize(async () => {
        const name = req.params.name;
        await requireRemote(name);
        const pending = state.pending[name];
        if (!pending) throw new AppError('该存储没有待完成的授权步骤。');
        let result = req.body.result;
        if (typeof result !== 'string' || result.length > 65536)
          throw new AppError('授权回答格式不正确。');
        // 无头服务器只使用远程授权，避免在容器中启动浏览器。
        if (pending.option.name === 'config_is_local') result = 'false';
        await backup();
        const output = await engine.call('config/update', {
          name,
          parameters: {},
          opt: { nonInteractive: true, continue: true, state: pending.state, result },
        });
        const next = question(output);
        if (next) state.pending[name] = next;
        else delete state.pending[name];
        await save();
        return { name, pending: next };
      }),
    ),
  );
  app.delete('/api/remotes/:name', async (req, res) =>
    res.json(
      await serialize(async () => {
        freeRemote(req.params.name, true);
        if (direct115.record(req.params.name) || driveGroups.record(req.params.name)) {
          delete state.direct115Remotes[req.params.name];
          state.driveGroups = state.driveGroups.filter((group) => group.name !== req.params.name);
          direct115.reset();
          delete state.remotePolicies[req.params.name];
          delete state.health[req.params.name];
          await save();
          return { ok: true };
        }
        if (cloudRecord(req.params.name)) {
          await cloud.remove(req.params.name);
          delete state.remotePolicies[req.params.name];
          delete state.health[req.params.name];
          await save();
          return { ok: true };
        }
        await requireRemote(req.params.name);
        await backup();
        await engine.call('config/delete', { name: req.params.name });
        delete state.pending[req.params.name];
        delete state.remotePolicies[req.params.name];
        delete state.health[req.params.name];
        await save();
        return { ok: true };
      }),
    ),
  );
  app.post('/api/remotes/:name/test', async (req, res) => {
    if (cloudRecord(req.params.name)) await serialize(() => cloud.read(req.params.name));
    const endpoint = await resolveFs({ remote: req.params.name, path: req.body.path || '' });
    const started = Date.now();
    await engine.call('operations/list', {
      fs: endpoint.fs,
      remote: '',
      opt: { dirsOnly: true, noModTime: true, noMimeType: true },
    });
    res.json({ ok: true, latency: Date.now() - started });
  });
  app.get('/api/files', async (req, res) => {
    const endpoint = await resolveFs({
      remote: req.query.remote || 'local',
      path: req.query.path || '',
    });
    const data = await engine.call('operations/list', {
      fs: endpoint.fs,
      remote: '',
      opt: { showHash: false },
    });
    const items = data.list || [];
    res.json({ items: items.slice(0, 10000), truncated: items.length > 10000 });
  });
  app.post('/api/files/mkdir', async (req, res) => {
    if (direct115.record(req.body.remote)) throw new AppError('115 直接连接暂仅支持读取。');
    const endpoint = await resolveFs(req.body);
    if (!cleanPath(req.body.path)) throw new AppError('请输入新建文件夹路径。');
    await engine.call('operations/mkdir', { fs: endpoint.fs, remote: '' });
    res.json({ ok: true });
  });
  app.get('/api/settings', (req, res) => res.json(state.settings));
  app.put('/api/settings', async (req, res) =>
    res.json(
      await serialize(async () => {
        const settings = validateSettings(req.body);
        await engine.call('core/bwlimit', { rate: settings.bandwidth || 'off' });
        state.settings = settings;
        await save();
        return settings;
      }),
    ),
  );
  app.get('/api/schedules', (req, res) =>
    res.json(
      state.schedules.map((schedule) =>
        scheduleView(
          schedule,
          clock(),
          state.jobs.find((job) => job.id === schedule.runningJobId),
        ),
      ),
    ),
  );
  app.post('/api/schedules', async (req, res) =>
    res.json(
      await serialize(async () => {
        if (state.schedules.length >= 50) throw new AppError('最多保存 50 个计划任务。', 409);
        const input = { ...validateSchedule(req.body), ...transferOptions(req.body) };
        await transferEndpoints(input);
        const schedule = {
          ...input,
          id: randomBytes(8).toString('hex'),
          usage: {},
          runningJobId: null,
          createdAt: new Date().toISOString(),
          error: '',
        };
        state.schedules.unshift(schedule);
        await save();
        return scheduleView(schedule, clock());
      }),
    ),
  );
  app.put('/api/schedules/:id', async (req, res) =>
    res.json(
      await serialize(async () => {
        const schedule = findSchedule(req.params.id);
        if (schedule.runningJobId)
          throw new AppError('请先停用并等待当前任务结束，再修改计划。', 409);
        const input = { ...validateSchedule(req.body), ...transferOptions(req.body) };
        if (Object.keys(schedule.usage).length && input.timezone !== schedule.timezone)
          throw new AppError('已执行的计划不能修改时区，请为新时区新建计划。');
        await transferEndpoints(input);
        Object.assign(schedule, input);
        const day = usage(schedule, calendar(clock(), schedule.timezone).date);
        if (schedule.enabled && day.outcome === 'paused') day.outcome = 'interrupted';
        await save();
        return scheduleView(schedule, clock());
      }),
    ),
  );
  app.post('/api/schedules/:id/run', async (req, res) =>
    res.json(
      await serialize(async () => {
        const job = await runSchedule(findSchedule(req.params.id), true);
        await save();
        return job;
      }),
    ),
  );
  app.post('/api/schedules/:id/toggle', async (req, res) =>
    res.json(
      await serialize(async () => {
        const schedule = findSchedule(req.params.id);
        if (typeof req.body.enabled !== 'boolean') throw new AppError('启用状态必须为布尔值。');
        schedule.enabled = req.body.enabled;
        const job = state.jobs.find(
          (item) => item.id === schedule.runningJobId && item.status === 'running',
        );
        if (!schedule.enabled && job && !job.stopping) await stopJob(job);
        if (!schedule.enabled && !job && schedule.runningJobId) {
          const pending = state.jobs.find((item) => item.id === schedule.runningJobId);
          if (pending) pending.status = 'stopped';
          schedule.runningJobId = null;
          usage(schedule, calendar(clock(), schedule.timezone).date, true).outcome = 'paused';
        }
        const day = usage(schedule, calendar(clock(), schedule.timezone).date);
        if (schedule.enabled && day.outcome === 'paused') day.outcome = 'interrupted';
        await save();
        return scheduleView(schedule, clock());
      }),
    ),
  );
  app.delete('/api/schedules/:id', async (req, res) =>
    res.json(
      await serialize(async () => {
        const schedule = findSchedule(req.params.id);
        if (schedule.runningJobId)
          throw new AppError('请先停用并等待当前任务结束，再删除计划。', 409);
        state.schedules = state.schedules.filter((item) => item.id !== schedule.id);
        await save();
        return { ok: true };
      }),
    ),
  );
  app.get('/api/operations', (req, res) => res.json(operations.view()));
  app.put('/api/operations', async (req, res) =>
    res.json(
      await serialize(async () => {
        state.operations = operationSettings(req.body);
        await save();
        return operations.view();
      }),
    ),
  );
  app.put('/api/accounts/:name', async (req, res) =>
    res.json(
      await serialize(async () => {
        if (req.params.name !== 'local') await requireRemote(req.params.name);
        if (
          state.jobs.some(
            (job) =>
              job.status === 'running' &&
              [job.source.remote, job.destination.remote, job.targetRemote].includes(
                req.params.name,
              ),
          )
        )
          throw new AppError('请先暂停使用此账号的传输。', 409);
        const policy = operations.setPolicy(req.params.name, req.body);
        await save();
        return policy;
      }),
    ),
  );
  app.post('/api/accounts/:name/check', async (req, res) =>
    res.json(await serialize(() => operations.healthCheck(req.params.name))),
  );
  app.post('/api/quota-groups', async (req, res) =>
    res.json(
      await serialize(async () => {
        const group = operations.setGroup(req.body);
        await save();
        return group;
      }),
    ),
  );
  app.put('/api/quota-groups/:id', async (req, res) =>
    res.json(
      await serialize(async () => {
        if (
          state.jobs.some(
            (job) =>
              job.status === 'running' &&
              operations.groups(job).some((g) => g.id === req.params.id),
          )
        )
          throw new AppError('请先暂停使用此额度组的任务。', 409);
        const group = operations.setGroup(req.body, req.params.id);
        await save();
        return group;
      }),
    ),
  );
  app.delete('/api/quota-groups/:id', async (req, res) =>
    res.json(
      await serialize(async () => {
        if (Object.values(state.remotePolicies).some((policy) => policy.groupId === req.params.id))
          throw new AppError('请先解除账号与额度组的关联。', 409);
        state.quotaGroups = state.quotaGroups.filter((group) => group.id !== req.params.id);
        await save();
        return { ok: true };
      }),
    ),
  );
  app.post('/api/transfers/analyze', async (req, res) => {
    await transferEndpoints({ ...req.body, dryRun: true });
    if (mediaEnabled(req.body)) {
      const budgets = [
        Number(req.body.dailyBytes) || 0,
        ...operations.groups(req.body).map((group) => group.dailyBytes),
        driveGroups.maxFileBudget(req.body.destination.remote),
      ].filter(Boolean);
      const budget = budgets.length ? Math.min(...budgets) : 0;
      const plan = req.body.scanId
        ? await scans.analyzed(req.body.scanId, req.body, budget)
        : await media.preview({ ...req.body, dailyBytes: budget });
      const oversizedCount = plan.oversizedCount;
      res.json({
        ...plan,
        count: plan.totalFiles,
        bytes: plan.totalBytes,
        largest: plan.largest,
        oversizedCount,
        warning: oversizedCount ? '部分文件超过每日容量，请选择完成当前文件后停止或调整额度。' : '',
      });
    } else res.json(await operations.analyze(req.body));
  });
  app.post('/api/media/preview', async (req, res) => {
    await transferEndpoints({ ...req.body, mode: 'copy', dryRun: true });
    res.json(await media.preview({ ...req.body, mode: 'copy' }));
  });
  app.post('/api/media/scans', async (req, res) =>
    res.status(202).json(
      await serialize(async () => {
        if (!mediaEnabled(req.body)) throw new AppError('扫描仅用于影视或多目录复制任务。');
        await transferEndpoints({ ...req.body, mode: 'copy', dryRun: true });
        return scans.create(req.body);
      }),
    ),
  );
  app.get('/api/media/scans', (req, res) => res.json(scans.list()));
  app.get('/api/media/scans/:id', (req, res) => res.json(scans.view(scans.get(req.params.id))));
  app.delete('/api/media/scans/:id', (req, res) => res.json(scans.cancel(req.params.id)));
  app.get('/api/notifications', (req, res) => res.json(notifications.view()));
  app.put('/api/notifications', async (req, res) =>
    res.json(
      await serialize(async () => {
        const view = notifications.configure(req.body);
        await save();
        return view;
      }),
    ),
  );
  app.post('/api/notifications/test', async (req, res) => res.json(await notifications.test()));
  app.post('/api/backups/export', async (req, res) =>
    res.json(await serialize(() => backups.export(req.body.passphrase))),
  );
  app.post('/api/backups/inspect', async (req, res) =>
    res.json(await backups.inspect(req.body.archive, req.body.passphrase)),
  );
  app.post('/api/backups/restore', async (req, res) =>
    res.json(
      await serialize(() => {
        if (scans.list().some((scan) => ['queued', 'running', 'cancelling'].includes(scan.status)))
          throw new AppError('请先完成或取消后台扫描，再恢复备份。', 409);
        return backups.restore(req.body.archive, req.body.passphrase, req.body.confirmRestore);
      }),
    ),
  );
  const findJob = (id) => {
    const job = state.jobs.find((item) => item.id === id);
    if (!job) throw new AppError('任务不存在。', 404);
    return job;
  };
  app.get('/api/jobs', (req, res) =>
    res.json(
      state.jobs.map((job) => {
        const { files, events, mediaRetryFiles, mediaPlan, scanBinding, ...summary } = job;
        return { ...summary, fileCount: files?.length || 0 };
      }),
    ),
  );
  app.get('/api/jobs/:id', (req, res) => res.json(findJob(req.params.id)));
  app.get('/api/jobs/:id/export', (req, res) => {
    const job = findJob(req.params.id);
    const quote = (value) =>
      '"' +
      (/^[=+@-]/.test(String(value || '')) ? "'" : '') +
      String(value ?? '').replaceAll('"', '""') +
      '"';
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="job-${job.id}.csv"`,
    });
    res.send(
      '\uFEFF' +
        [
          ['文件', '目标文件', '状态', '大小', '已传字节', '检查', '原因', '错误', '时间'],
          ...(job.files || []).map((file) => [
            file.path,
            file.targetFile || file.path,
            file.status,
            file.size,
            file.bytes,
            file.check || '',
            file.reason || '',
            file.error,
            file.at,
          ]),
        ]
          .map((row) => row.map(quote).join(','))
          .join('\r\n'),
    );
  });
  app.post('/api/jobs/:id/pause', async (req, res) =>
    res.json(
      await serialize(async () => {
        const job = findJob(req.params.id);
        if (job.status === 'running') await stopJob(job, 'pause');
        else if (ACTIVE.includes(job.status)) job.status = 'paused';
        else throw new AppError('当前任务不能暂停。');
        await save();
        return { ok: true };
      }),
    ),
  );
  app.post('/api/jobs/:id/resume', async (req, res) =>
    res.json(
      await serialize(async () => {
        const job = findJob(req.params.id);
        if (!['paused', 'blocked', 'failed', 'stopped', 'interrupted'].includes(job.status))
          throw new AppError('当前任务不能恢复。');
        if (job.verification?.status === 'running')
          throw new AppError('请等待校验结束，或先停止校验后恢复传输。', 409);
        if (job.status === 'blocked') {
          for (const remote of new Set([job.source.remote, job.destination.remote]))
            await operations.healthCheck(remote);
        }
        if (job.scheduleId) {
          const schedule = findSchedule(job.scheduleId);
          if (!schedule.enabled) throw new AppError('请先启用所属计划。');
          if (schedule.runningJobId && schedule.runningJobId !== job.id)
            throw new AppError('所属计划已有其它任务运行，请先等待结束。', 409);
          schedule.runningJobId = job.id;
        }
        job.status = 'queued';
        job.stopping = false;
        job.stopReason = null;
        delete job.reason;
        delete job.rawError;
        job.retries = 0;
        delete job.retryAt;
        await save();
        await operations.dispatch();
        await save();
        return job;
      }),
    ),
  );
  app.post('/api/jobs/:id/retry-files', async (req, res) =>
    res.json(
      await serialize(async () => {
        const job = findJob(req.params.id);
        if (ACTIVE.includes(job.status) || job.verification?.status === 'running')
          throw new AppError('请先等待传输或校验结束。', 409);
        const schedule = job.scheduleId ? findSchedule(job.scheduleId) : null;
        const latest = new Map();
        for (const file of job.files || []) latest.set(file.path, file);
        if (mediaEnabled(job)) {
          const failed = [...latest.values()].filter((file) => file.status === 'failed');
          if (!failed.length) throw new AppError('没有已记录的失败文件。');
          return startJob(
            { ...job, name: `${job.name} · 失败重试`, mode: 'copy', selections: [], dryRun: false },
            schedule,
            { manual: true, mediaRetryFiles: failed },
          );
        }
        const selections = [...latest.values()]
          .filter((file) => file.status === 'failed')
          .map((file) => ({ path: cleanPath(file.path), isDir: false }));
        if (!selections.length) throw new AppError('没有已记录的失败文件。');
        return startJob(
          {
            ...job,
            name: `${job.name} · 失败重试`,
            mode: 'copy',
            selections,
            dryRun: false,
          },
          schedule,
          { manual: true },
        );
      }),
    ),
  );
  app.post('/api/jobs/:id/verify', async (req, res) =>
    res.json(
      await serialize(async () => {
        const job = findJob(req.params.id);
        if (ACTIVE.includes(job.status) || job.verification?.status === 'running')
          throw new AppError('请等待传输或校验结束。', 409);
        if (
          state.jobs.some(
            (item) =>
              item.status === 'running' &&
              [item.source.remote, item.destination.remote].some((remote) =>
                [job.source.remote, job.destination.remote].includes(remote),
              ),
          )
        )
          throw new AppError('请先暂停使用这些账号的其他传输。', 409);
        if (!['size', 'hash'].includes(req.body.mode)) throw new AppError('请选择大小或哈希校验。');
        if (mediaEnabled(job)) {
          const verification = {
            status: 'running',
            mode: req.body.mode,
            startedAt: new Date().toISOString(),
          };
          job.verification = verification;
          await save();
          const active = () =>
            !closing && job.verification === verification && verification.status === 'running';
          const task = media
            .verify(job, req.body.mode, {
              active,
              onProgress: (report) =>
                serialize(async () => {
                  if (!active()) return;
                  verification.report = structuredClone(report);
                  await save();
                }),
            })
            .then((report) =>
              serialize(async () => {
                if (!active()) return;
                Object.assign(verification, {
                  status: report.success ? 'completed' : 'failed',
                  report,
                  finishedAt: new Date().toISOString(),
                });
                await save();
              }),
            )
            .catch((error) =>
              serialize(async () => {
                if (!active()) return;
                Object.assign(verification, {
                  status: 'failed',
                  error: safeError(error.message),
                  finishedAt: new Date().toISOString(),
                });
                await save();
              }),
            )
            .finally(() => verificationTasks.delete(task));
          verificationTasks.add(task);
          return verification;
        }
        const { source, destination } = await transferEndpoints({ ...job, mode: 'copy' });
        const result = await engine.call('operations/check', {
          srcFs: source.fs,
          dstFs: destination.fs,
          oneWay: true,
          download: false,
          combined: true,
          match: true,
          _async: true,
          _filter: await operations.prepareFilter(job),
          _config: { SizeOnly: req.body.mode === 'size' },
        });
        job.verification = {
          status: 'running',
          mode: req.body.mode,
          jobId: result.jobid,
          startedAt: new Date().toISOString(),
        };
        await save();
        return job.verification;
      }),
    ),
  );
  app.post('/api/jobs/:id/verify/stop', async (req, res) =>
    res.json(
      await serialize(async () => {
        const job = findJob(req.params.id);
        if (job.verification?.status !== 'running') throw new AppError('当前没有运行中的校验。');
        if (!mediaEnabled(job) && job.verification.jobId !== undefined)
          await engine.call('job/stop', { jobid: job.verification.jobId });
        job.verification.status = 'interrupted';
        job.verification.error = '已停止校验。';
        await save();
        return job.verification;
      }),
    ),
  );
  app.post('/api/jobs', async (req, res) =>
    res.json(
      await serialize(async () => {
        if (req.body.scanId && !mediaEnabled(req.body))
          throw new AppError('扫描结果仅支持影视复制任务。');
        const snapshot = req.body.scanId ? await scans.confirmed(req.body.scanId, req.body) : {};
        const job = await startJob(req.body, null, snapshot);
        await save();
        return job;
      }),
    ),
  );
  app.post('/api/jobs/:id/stop', async (req, res) =>
    res.json(
      await serialize(async () => {
        const job = state.jobs.find((job) => job.id === req.params.id);
        if (!job) throw new AppError('任务不存在。', 404);
        if (job.status === 'running') await stopJob(job);
        else if (ACTIVE.includes(job.status) || job.status === 'paused') {
          job.status = 'stopped';
          if (job.scheduleId) findSchedule(job.scheduleId).runningJobId = null;
        } else throw new AppError('该任务已经结束。');
        await save();
        return { ok: true };
      }),
    ),
  );
  let closing = false;
  let nextEngineRestart = 0;
  async function pollJobs() {
    for (const job of state.jobs.filter((item) => item.status === 'running')) {
      const schedule = job.scheduleId
        ? state.schedules.find((item) => item.id === job.scheduleId)
        : null;
      try {
        if (
          schedule &&
          !job.stopping &&
          calendar(clock(), schedule.timezone).date !== job.quotaDate
        )
          await stopJob(job, 'rollover');
        else if (!job.stopping && operations.rollover(job)) await stopJob(job, 'quota_rollover');
        const [status, stats] = mediaEnabled(job)
          ? await media.poll(job).then(({ status, stats }) => [status, stats])
          : await Promise.all([
              engine.call('job/status', { jobid: job.jobId }),
              engine.call('core/stats', { group: job.group }),
            ]);
        job.stats = {
          bytes: stats.bytes,
          totalBytes: stats.totalBytes,
          speed: stats.speed,
          transfers: stats.transfers,
          totalTransfers: stats.totalTransfers,
          eta: stats.eta,
          ...operations.diagnostics(job, stats),
          ...(mediaEnabled(job)
            ? {
                completedBytes: stats.completedBytes,
                skipped: stats.skipped,
                conflicts: stats.conflicts,
              }
            : {}),
        };
        if (schedule) account(schedule, job, stats, status, Date.now());
        operations.account(job, stats);
        try {
          if (!mediaEnabled(job)) await operations.details(job);
        } catch {
          /* Preserve execution if history is temporarily unavailable. */
        }
        delete job.pollError;
        if (status.finished) {
          if (
            !mediaEnabled(job) &&
            (stats.transfers || 0) >
              job.files.filter(
                (file) => file.attempt === job.attempts && file.status === 'completed',
              ).length
          )
            job.detailsTruncated = true;
          job.status = job.stopping ? 'stopped' : status.success ? 'completed' : 'failed';
          job.error = safeError(status.error || '');
          job.finishedAt = status.endTime;
          if (schedule) finishSchedule(schedule, job, status);
          await operations.finished(job, schedule, status);
        }
      } catch (error) {
        // A temporary RC error must not create a second concurrent run.
        job.pollError = safeError(error.message);
      }
    }
  }
  async function tick() {
    if (closing) return;
    if (!engine.ready) {
      if (engine.stopping) return;
      if (
        Date.now() < nextEngineRestart ||
        (engine.child && engine.child.exitCode === null && !engine.child.killed)
      )
        return;
      nextEngineRestart = Date.now() + 30000;
      await serialize(async () => {
        if (
          engine.ready ||
          engine.stopping ||
          closing ||
          (engine.child && engine.child.exitCode === null && engine.child.signalCode === null)
        )
          return;
        for (const job of state.jobs.filter((item) => item.status === 'running')) {
          job.status = state.operations.autoResume ? 'queued' : 'paused';
          if (job.scheduleId) {
            const schedule = findSchedule(job.scheduleId);
            schedule.runningJobId = job.id;
            usage(schedule, job.quotaDate, true).outcome = 'interrupted';
          }
          operations.event(job, 'rclone 服务中断，保存任务等待恢复');
        }
        for (const job of state.jobs) {
          if (job.verification?.status === 'running') {
            job.verification.status = 'interrupted';
            job.verification.error = 'rclone 服务重启，请重新执行校验。';
          }
        }
        await engine.start();
        if (engine.ready)
          await engine.call('core/bwlimit', { rate: state.settings.bandwidth || 'off' });
        await save();
      });
      return;
    }
    await serialize(async () => {
      let changed = state.jobs.some((job) => job.status === 'running');
      await pollJobs();
      for (const job of state.jobs.filter(
        (item) => item.verification?.status === 'running' && !mediaEnabled(item),
      )) {
        try {
          const status = await engine.call('job/status', { jobid: job.verification.jobId });
          if (status.finished) {
            job.verification = {
              ...job.verification,
              status: status.success && status.output?.success !== false ? 'completed' : 'failed',
              report: status.output || {},
              error: safeError(status.error || ''),
              finishedAt: status.endTime,
            };
            changed = true;
          }
        } catch (error) {
          job.verification.error = safeError(error.message);
        }
      }
      for (const schedule of state.schedules) {
        if (!due(schedule, clock())) continue;
        try {
          await runSchedule(schedule);
          changed = true;
        } catch (error) {
          if (error.status === 409) continue; // Wait for a transfer slot.
          const day = usage(schedule, calendar(clock(), schedule.timezone).date, true);
          day.outcome = 'failed';
          schedule.error = safeError(error.message);
          changed = true;
        }
      }
      await operations.dispatch();
      if (state.jobs.some((job) => ACTIVE.includes(job.status))) changed = true;
      if (changed) await save();
    });
  }
  let polling = false;
  const timer = setInterval(async () => {
    if (polling || closing) return;
    polling = true;
    try {
      await tick();
    } catch (error) {
      console.error('任务记录保存失败：', safeError(error.message));
    } finally {
      polling = false;
    }
  }, 1000);
  timer.unref();
  let serviceBusy = false;
  const services = setInterval(async () => {
    if (serviceBusy || closing || !engine.ready) return;
    serviceBusy = true;
    try {
      await notifications.tick();
      const remote = (await remotes()).find(
        (remote) =>
          !remote.pending &&
          (!state.health[remote.name]?.checkedAt ||
            Date.now() - Date.parse(state.health[remote.name].checkedAt) >
              state.operations.healthMinutes * 60000),
      );
      if (remote) await serialize(() => operations.healthCheck(remote.name));
    } catch {
      /* A service outage must not stop transfers. */
    } finally {
      serviceBusy = false;
    }
  }, 60000);
  services.unref();
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在。' }));
  app.use(express.static(path.join(projectRoot, 'dist'), { index: false }));
  app.get('/{*path}', (req, res) => res.sendFile(path.join(projectRoot, 'dist/index.html')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || 500;
    res.status(status).json({
      error: status === 500 ? '服务发生错误，请检查数据目录权限。' : safeError(error.message),
    });
    if (status === 500) console.error('面板错误：', safeError(error.message));
  });
  return {
    app,
    engine,
    host,
    tick,
    operations,
    direct115,
    scans,
    driveGroups,
    backups,
    notifications,
    async close() {
      closing = true;
      clearInterval(timer);
      clearInterval(services);
      await scans.close();
      await media.close();
      await authQueue.catch(() => {});
      await mutationQueue.catch(() => {});
      for (const job of state.jobs)
        if (mediaEnabled(job) && job.verification?.status === 'running') {
          job.verification.status = 'interrupted';
          job.verification.error = '服务关闭，请重新执行校验。';
        }
      if (engine.ready) {
        for (const job of state.jobs.filter(
          (item) => item.status === 'running' && !item.stopping,
        )) {
          try {
            await stopJob(job, 'shutdown');
          } catch {
            /* Engine shutdown also cancels jobs. */
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        await pollJobs();
        await save();
      }
      await engine.stop();
      await direct115.close();
      await writeQueue.catch(() => {});
    },
  };
}
