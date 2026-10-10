import { randomBytes, scrypt as derive, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { AppError, remoteName, cleanPath, validateSettings } from './validation.mjs';
import { operationSettings, transferOptions } from './operations.mjs';
import { validateSchedule } from './scheduling.mjs';

const scrypt = promisify(derive),
  compress = promisify(gzip),
  decompress = promisify(gunzip);
const MAX = 64 * 1024 * 1024;
function password(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 1024)
    throw new AppError('备份密码需为 12–1024 个字符。');
}
export async function encryptBackup(payload, passphrase) {
  password(passphrase);
  const salt = randomBytes(16),
    iv = randomBytes(12);
  const key = await scrypt(passphrase, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('rclone-studio-backup:v1'));
  const encoded = Buffer.from(JSON.stringify(payload));
  if (encoded.length > MAX) throw new AppError('备份原始内容超过 64 MiB，请清理历史明细。');
  const clear = await compress(encoded);
  if (clear.length > MAX) throw new AppError('备份超过 64 MiB，请先清理历史文件明细。');
  const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]);
  return {
    format: 'rclone-studio-backup',
    version: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  };
}
export async function decryptBackup(archive, passphrase) {
  password(passphrase);
  if (
    !archive ||
    archive.format !== 'rclone-studio-backup' ||
    archive.version !== 1 ||
    typeof archive.data !== 'string' ||
    archive.data.length > MAX * 1.4
  )
    throw new AppError('备份格式或大小无效。');
  try {
    const salt = Buffer.from(archive.salt, 'base64'),
      iv = Buffer.from(archive.iv, 'base64'),
      tag = Buffer.from(archive.tag, 'base64');
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error();
    const key = await scrypt(passphrase, salt, 32);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from('rclone-studio-backup:v1'));
    decipher.setAuthTag(tag);
    const clear = Buffer.concat([
      decipher.update(Buffer.from(archive.data, 'base64')),
      decipher.final(),
    ]);
    const payload = JSON.parse((await decompress(clear, { maxOutputLength: MAX })).toString());
    validatePayload(payload);
    return payload;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('备份密码不正确，或文件损坏。');
  }
}
function validatePayload(payload) {
  if (
    !payload ||
    payload.version !== 1 ||
    typeof payload.config !== 'string' ||
    payload.config.length > 8 * 1024 * 1024 ||
    !payload.state ||
    !Array.isArray(payload.state.jobs) ||
    !Array.isArray(payload.state.schedules) ||
    payload.state.jobs.length > 1000 ||
    payload.state.schedules.length > 50 ||
    !Array.isArray(payload.storages)
  )
    throw new AppError('备份内容不完整。');
  validateSettings(payload.state.settings);
  operationSettings(payload.state.operations);
  for (const schedule of payload.state.schedules) validateSchedule(schedule);
  for (const job of payload.state.jobs) {
    transferOptions(job);
    for (const endpoint of [job.source, job.destination]) {
      if (endpoint.remote !== 'local') remoteName(endpoint.remote);
      cleanPath(endpoint.path);
    }
  }
  const namespace = payload.state.openlist?.namespace;
  if (
    payload.storages.length &&
    (!/^\/rclone-studio-[a-f0-9]+$/.test(namespace || '') ||
      payload.storages.length !== Object.keys(payload.state.cloudRemotes || {}).length)
  )
    throw new AppError('网盘备份目录或记录不匹配。');
  for (const storage of payload.storages) {
    const record = payload.state.cloudRemotes?.[storage.name];
    if (
      !record ||
      storage.mount.mount_path !== record.mountPath ||
      !record.mountPath.startsWith(namespace + '/') ||
      storage.mount.driver !== record.driver
    )
      throw new AppError('网盘备份挂载记录无效。');
  }
}

export class Backups {
  constructor(context) {
    Object.assign(this, context);
  }
  idle() {
    if (
      this.state.jobs.some(
        (job) =>
          ['running', 'queued', 'retry_wait', 'waiting_quota', 'blocked'].includes(job.status) ||
          job.verification?.status === 'running',
      ) ||
      this.state.schedules.some((schedule) => schedule.enabled)
    )
      throw new AppError('完整备份和恢复前，请暂停待执行任务并停用所有计划。', 409);
  }
  async snapshot() {
    const storages = [];
    for (const record of Object.values(this.state.cloudRemotes || {})) {
      const mount = await this.cloud.storage(record);
      if (!mount) throw new AppError(`网盘 ${record.name} 的挂载缺失，请先修复连接。`, 409);
      storages.push({ name: record.name, mount });
    }
    let config = '';
    try {
      config = await readFile(this.config, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      state: structuredClone(this.state),
      config,
      storages,
    };
  }
  async export(passphrase) {
    this.idle();
    return encryptBackup(await this.snapshot(), passphrase);
  }
  async inspect(archive, passphrase) {
    const payload = await decryptBackup(archive, passphrase);
    return {
      createdAt: payload.createdAt,
      jobs: payload.state.jobs.length,
      schedules: payload.state.schedules.length,
      cloudAccounts: payload.storages.length,
      remotes: [...payload.config.matchAll(/^\[([^\]\r\n]+)\]/gm)].map((match) => match[1]),
      openlistUrl: payload.state.openlist?.url || null,
      restorePaused: true,
    };
  }
  async apply(payload) {
    const destination = { ...this.state.openlist };
    const restored = structuredClone(payload.state);
    if (payload.storages.length && !destination.url)
      throw new AppError('请先连接用于恢复的 OpenList 服务。');
    if (payload.storages.length) {
      restored.openlist = {
        ...restored.openlist,
        url: destination.url,
        username: destination.username,
        passwordHash: destination.passwordHash,
        adminToken: destination.adminToken,
        davUserId: null,
      };
    }
    for (const key of Object.keys(this.state)) delete this.state[key];
    Object.assign(this.state, restored);
    this.cloud.token = '';
    for (const schedule of this.state.schedules) {
      schedule.enabled = false;
      schedule.runningJobId = null;
    }
    for (const job of this.state.jobs) {
      if (
        ['running', 'queued', 'retry_wait', 'waiting_quota', 'blocked', 'interrupted'].includes(
          job.status,
        )
      )
        job.status = 'paused';
      if (job.verification?.status === 'running') job.verification.status = 'interrupted';
    }
    this.state.notificationQueue = [];
    this.state.notifications = { ...this.state.notifications, enabled: false };
    this.state.health = {};
    await writeFile(`${this.config}.restore.tmp`, payload.config, { mode: 0o600 });
    await rename(`${this.config}.restore.tmp`, this.config);
    if (payload.storages.length) {
      await this.cloud.ensureUser();
      for (const { name, mount } of payload.storages) {
        const record = this.state.cloudRemotes[name];
        record.storageId = null;
        const existing = await this.cloud.storage(record);
        const { id: ignored, ...fields } = mount;
        // Restoring a pending SMS login must not automatically send a new message.
        if (fields.driver === 'GuangYaPan') {
          const addition = JSON.parse(fields.addition || '{}');
          fields.addition = JSON.stringify({ ...addition, send_code: false, verify_code: '' });
        }
        let created, initError;
        try {
          created = await this.cloud.call(
            existing ? '/admin/storage/update' : '/admin/storage/create',
            { ...fields, ...(existing ? { id: existing.id } : {}) },
          );
        } catch (error) {
          if (!(error.storageId || error.code >= 500)) throw error;
          initError = error;
        }
        record.storageId = existing?.id || created?.id || initError?.storageId || null;
        const storage = await this.cloud.storage(record);
        if (!storage) throw initError || new AppError('恢复挂载失败。', 502);
        record.phase = this.cloud.view(record, storage).phase;
      }
      await this.cloud.rebind();
    }
    await this.engine.stop();
    await this.engine.start();
    if (!this.engine.ready) throw new AppError('恢复后 rclone 无法启动。', 502);
    await this.engine.call('core/bwlimit', { rate: this.state.settings.bandwidth || 'off' });
    await this.save();
  }
  async restore(archive, passphrase, confirmed) {
    if (confirmed !== true) throw new AppError('请确认覆盖当前配置并以暂停状态恢复。');
    this.idle();
    const payload = await decryptBackup(archive, passphrase);
    const before = await this.snapshot();
    const folder = path.join(this.dataDir, 'full-backups');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const recovery = path.join(folder, `before-restore-${Date.now()}.json`);
    await writeFile(recovery, JSON.stringify(await encryptBackup(before, passphrase)), {
      mode: 0o600,
    });
    try {
      await this.apply(payload);
    } catch (error) {
      try {
        await this.apply(before);
      } catch {
        throw new AppError(
          '恢复失败，自动回滚未完成。恢复前的加密备份保存在 data/panel/full-backups，请按部署说明恢复。',
          500,
        );
      }
      throw new AppError('恢复失败，已回滚到原配置。请检查 OpenList 服务及挂载权限。', 502);
    }
    return { ok: true, paused: true, recoveryFile: path.basename(recovery) };
  }
}
