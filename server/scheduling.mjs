import { AppError, cleanPath } from './validation.mjs';
import { transferOptions } from './operations.mjs';

const formatters = new Map();
export function calendar(now, timezone) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(now)).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

export function validateSchedule(input) {
  if (!input || typeof input !== 'object') throw new AppError('计划配置格式不正确。');
  const name = String(input.name || '').trim();
  if (!name || name.length > 80) throw new AppError('计划名称需为 1–80 个字符。');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.startTime || ''))
    throw new AppError('开始时间请使用 HH:mm 格式。');
  if (typeof input.timezone !== 'string' || input.timezone.length > 80)
    throw new AppError('请选择有效的时区。');
  try {
    calendar(Date.now(), input.timezone);
  } catch {
    throw new AppError('时区无效，请使用 Asia/Shanghai 等名称。');
  }
  const dailyBytes = Number(input.dailyBytes ?? 0);
  const dailySeconds = Number(input.dailySeconds ?? 0);
  const scanIntervalMinutes = Number(input.scanIntervalMinutes ?? 0);
  if (
    !Number.isInteger(scanIntervalMinutes) ||
    (scanIntervalMinutes !== 0 && (scanIntervalMinutes < 5 || scanIntervalMinutes > 1440))
  )
    throw new AppError('检查间隔需为 5–1440 分钟，0 表示每天一次。');
  if (!Number.isSafeInteger(dailyBytes) || dailyBytes < 0 || dailyBytes > 1024 ** 5)
    throw new AppError('每日容量需为 0–1 PiB 之间的整数个字节，0 表示不限。');
  if (!Number.isInteger(dailySeconds) || dailySeconds < 0 || dailySeconds > 86400)
    throw new AppError('每日运行时长需为 0–86400 秒，0 表示不限。');
  if (!dailyBytes && !dailySeconds && !scanIntervalMinutes)
    throw new AppError('请至少设置每日容量、每日运行时长或重复检查间隔。');
  if (!['hard', 'soft'].includes(input.cutoffMode))
    throw new AppError('请选择立即停止或完成当前文件后停止。');
  if (!['copy', 'sync'].includes(input.mode)) throw new AppError('请选择复制或同步模式。');
  if (input.mode === 'sync' && input.confirmDelete !== true)
    throw new AppError('定时同步会删除目标多余文件，请确认后再保存。');
  if (typeof input.enabled !== 'boolean') throw new AppError('启用状态必须为布尔值。');
  const endpoint = (value) => {
    if (!value || typeof value.remote !== 'string') throw new AppError('请选择源和目标存储。');
    return { remote: value.remote, path: cleanPath(value.path) };
  };
  return {
    name,
    startTime: input.startTime,
    timezone: input.timezone,
    dailyBytes,
    dailySeconds,
    cutoffMode: input.cutoffMode,
    enabled: input.enabled,
    scanIntervalMinutes,
    mode: input.mode,
    confirmDelete: input.mode === 'sync',
    source: endpoint(input.source),
    destination: endpoint(input.destination),
    ...transferOptions(input),
  };
}

export function usage(schedule, date, create = false) {
  const existing = schedule.usage?.[date];
  if (existing) return existing;
  const value = { bytes: 0, seconds: 0, outcome: 'waiting' };
  if (create) {
    schedule.usage ||= {};
    schedule.usage[date] = value;
    for (const key of Object.keys(schedule.usage).sort().slice(0, -31)) delete schedule.usage[key];
  }
  return value;
}

export function exhausted(schedule, day) {
  if (day.outcome === 'bytes_limit' || (schedule.dailyBytes && day.bytes >= schedule.dailyBytes))
    return 'bytes_limit';
  if (
    day.outcome === 'time_limit' ||
    (schedule.dailySeconds && day.seconds >= schedule.dailySeconds)
  )
    return 'time_limit';
  return null;
}

export function due(schedule, now) {
  const local = calendar(now, schedule.timezone);
  const day = usage(schedule, local.date);
  const nextScanAt = nextScan(schedule, day);
  return (
    schedule.enabled &&
    !schedule.runningJobId &&
    local.time >= schedule.startTime &&
    !exhausted(schedule, day) &&
    (['waiting', 'interrupted'].includes(day.outcome) ||
      (schedule.scanIntervalMinutes > 0 &&
        ['completed', 'failed'].includes(day.outcome) &&
        Number.isFinite(nextScanAt) &&
        nextScanAt <= now))
  );
}

function nextScan(schedule, day) {
  return (
    day.nextScanAt ??
    schedule.nextScanAt ??
    Date.parse(schedule.lastFinishedAt) + (schedule.scanIntervalMinutes || 0) * 60000
  );
}

export function scheduleView(schedule, now, job = null) {
  const local = calendar(now, schedule.timezone);
  const day = usage(schedule, local.date);
  const reason = exhausted(schedule, day);
  const status = schedule.runningJobId
    ? job?.status || 'running'
    : !schedule.enabled
      ? 'disabled'
      : reason || day.outcome;
  const tomorrow = new Date(`${local.date}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const nextDate =
    !schedule.runningJobId && !reason && ['waiting', 'interrupted'].includes(day.outcome)
      ? local.date
      : tomorrow.toISOString().slice(0, 10);
  let nextRun = `${nextDate} ${schedule.startTime}`;
  const nextScanAt = nextScan(schedule, day);
  if (
    !schedule.runningJobId &&
    !reason &&
    schedule.scanIntervalMinutes > 0 &&
    ['completed', 'failed'].includes(day.outcome) &&
    Number.isFinite(nextScanAt)
  ) {
    const next = calendar(Math.max(now, nextScanAt), schedule.timezone);
    if (next.date === local.date)
      nextRun = `${next.date} ${next.time < schedule.startTime ? schedule.startTime : next.time}`;
  }
  const { usage: ledger, ...publicSchedule } = schedule;
  return {
    ...publicSchedule,
    status,
    today: { date: local.date, bytes: day.bytes, seconds: day.seconds },
    nextRun: schedule.enabled && !schedule.runningJobId ? nextRun : null,
    readyNow: due(schedule, now),
  };
}

export function account(schedule, job, stats, status, now) {
  const day = usage(schedule, job.quotaDate, true);
  const bytes = Math.max(job.accountedBytes || 0, Number(stats.bytes) || 0);
  const ended = status.finished && status.endTime ? Date.parse(status.endTime) : now;
  const seconds = Math.max(
    job.accountedSeconds || 0,
    Math.max(0, (Math.min(now, ended) - Date.parse(job.startedAt || job.createdAt)) / 1000),
  );
  day.bytes += bytes - (job.accountedBytes || 0);
  day.seconds += seconds - (job.accountedSeconds || 0);
  job.accountedBytes = bytes;
  job.accountedSeconds = seconds;
}

export function finishSchedule(schedule, job, status) {
  const day = usage(schedule, job.quotaDate, true);
  const error = status.error || '';
  let reason;
  if (job.stopReason === 'rollover') reason = 'rollover';
  else if (job.stopReason === 'shutdown') reason = 'interrupted';
  else if (job.stopping) reason = 'paused';
  else if (/max transfer limit|transfer limit reached/i.test(error)) reason = 'bytes_limit';
  else if (/max duration|duration limit/i.test(error)) reason = 'time_limit';
  else if (
    !status.success &&
    job.limits?.seconds &&
    job.accountedSeconds >= job.limits.seconds - 0.05
  )
    reason = 'time_limit';
  else if (!status.success && job.limits?.bytes && job.accountedBytes >= job.limits.bytes)
    reason = 'bytes_limit';
  else reason = status.success ? 'completed' : 'failed';
  day.outcome = reason;
  schedule.runningJobId = null;
  schedule.lastFinishedAt = status.endTime;
  schedule.error = reason === 'failed' ? job.error : '';
  if (
    schedule.scanIntervalMinutes > 0 &&
    ['completed', 'failed'].includes(reason) &&
    status.endTime
  ) {
    day.nextScanAt = Date.parse(status.endTime) + schedule.scanIntervalMinutes * 60000;
    schedule.nextScanAt = day.nextScanAt;
  }
  job.status = ['bytes_limit', 'time_limit', 'rollover'].includes(reason)
    ? 'limited'
    : reason === 'paused'
      ? 'stopped'
      : reason;
  if (job.status === 'limited') {
    job.limitReason = reason;
    job.error = '';
  }
}
