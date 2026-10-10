import path from 'node:path';
import { realpath, lstat } from 'node:fs/promises';

export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function remoteName(value) {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value) ||
    value === 'local'
  ) {
    throw new AppError('存储名称需为 1–64 位字母、数字、下划线或连字符；local 为保留名称。');
  }
  return value;
}

export function cleanPath(value = '') {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\\]/.test(value))
    throw new AppError('目录路径格式不正确，请使用 / 分隔。');
  const parts = value.split('/').filter(Boolean);
  if (parts.some((part) => part === '..' || part === '.' || part.includes(':')))
    throw new AppError('目录路径不能包含 ..、. 或冒号。');
  return parts.join('/');
}

export function inside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export async function localPath(root, relative) {
  const base = await realpath(root);
  const target = path.resolve(base, cleanPath(relative));
  if (!inside(base, target)) throw new AppError('目录超出本地文件范围。');
  // 检查已存在的父目录和符号链接，防止通过链接逃离 LOCAL_ROOT。
  let cursor = target;
  while (inside(base, cursor)) {
    try {
      await lstat(cursor);
      if (!inside(base, await realpath(cursor)))
        throw new AppError('目录链接指向本地文件范围以外。');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      cursor = path.dirname(cursor);
    }
  }
  return target;
}

export function validateSettings(input) {
  const result = {};
  for (const [key, min, max] of [
    ['transfers', 1, 64],
    ['checkers', 1, 128],
    ['retries', 1, 20],
  ]) {
    const n = Number(input[key]);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new AppError(`${key} 必须是 ${min}–${max} 之间的整数。`);
    result[key] = n;
  }
  const rate = String(input.bandwidth ?? '').trim();
  if (rate && rate !== 'off' && !/^\d+(\.\d+)?[kKmMgGtT]?$/.test(rate))
    throw new AppError('带宽限制请使用 10M、500K 或留空。');
  result.bandwidth = rate === 'off' ? '' : rate;
  return result;
}

export function secretOption(option) {
  return Boolean(
    option.IsPassword ||
    (option.Sensitive && !['host', 'user', 'username', 'client_id'].includes(option.Name)) ||
    /(^|_)(pass(word)?|secret|token|cookie|credentials|access_key|key_pem|headers|api_key|private_key)(_|$)/i.test(
      option.Name,
    ),
  );
}

export function sanitizeRemote(name, config, provider, pending) {
  const parameters = Object.create(null);
  const configuredSecrets = [];
  const options = new Map((provider?.Options ?? []).map((option) => [option.Name, option]));
  for (const [key, value] of Object.entries(config)) {
    if (key === 'type') continue;
    if (
      secretOption(options.get(key) ?? { Name: key }) ||
      /https?:\/\/[^/@\s]+:[^/@\s]+@/.test(String(value))
    ) {
      if (value) configuredSecrets.push(key);
    } else parameters[key] = value;
  }
  return {
    name,
    type: config.type,
    description: config.description || '',
    parameters,
    configuredSecrets,
    pending: pending ?? null,
  };
}

export function safeError(message) {
  return String(message)
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/g, '$1***@')
    .replace(/(https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/)\b[a-f0-9]{48}\//gi, '$1***/')
    .replace(
      /(\b(?:\w*token|\w*secret|password|pass|cookie|access_key|authorization|UID|CID|SEID|KID)\b["'\s:=]+)[^\s,;}\n]+/gi,
      '$1***',
    )
    .slice(0, 700);
}
