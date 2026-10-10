import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { AppError, safeError } from './validation.mjs';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export class Engine {
  constructor({ binary, config }) {
    this.binary = binary;
    this.config = config;
    this.ready = false;
    this.error = '正在连接 rclone…';
    this.auth = `Basic ${Buffer.from(`studio:${randomBytes(32).toString('hex')}`).toString('base64')}`;
  }

  async start() {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null)
      throw new AppError('rclone 进程仍在运行，不能重复启动。', 409);
    this.stopping = false;
    this.ready = false;
    await mkdir(path.dirname(this.config), { recursive: true, mode: 0o700 });
    const port = await freePort();
    this.url = `http://127.0.0.1:${port}`;
    const [user, password] = Buffer.from(this.auth.slice(6), 'base64').toString().split(':');
    this.child = spawn(
      this.binary,
      [
        'rcd',
        '--config',
        this.config,
        '--rc-addr',
        `127.0.0.1:${port}`,
        '--rc-user',
        user,
        '--rc-pass',
        password,
        '--rc-job-expire-duration',
        '168h',
        '--rc-job-expire-interval',
        '1m',
        '--log-level',
        'ERROR',
        '--stats',
        '0',
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const owned = this.child;
    let failed = false;
    this.child.on('error', (error) => {
      failed = true;
      this.error =
        error.code === 'ENOENT'
          ? '未找到 rclone，请安装 rclone 或设置 RCLONE_BIN。'
          : '无法启动 rclone，请检查执行权限。';
    });
    this.child.on('exit', () => {
      failed = true;
      if (this.child !== owned) return;
      this.ready = false;
      if (!this.stopping) this.error = 'rclone 已停止，请检查配置文件并重启面板。';
    });
    this.child.stderr.on('data', (chunk) => {
      this.lastLog = safeError(chunk.toString());
    });
    for (let attempt = 0; attempt < 100 && !failed; attempt++) {
      try {
        this.version = await this.call('core/version', {}, 1500, true);
        this.ready = true;
        this.error = null;
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!failed) {
      this.error = 'rclone 启动超时，请检查 RCLONE_CONFIG（暂不支持加密配置文件）。';
      this.child.kill();
    }
  }

  async call(endpoint, parameters = {}, timeout = 35000, starting = false, signal) {
    if (!this.ready && !starting) throw new AppError(this.error || 'rclone 尚未就绪。', 503);
    let response;
    try {
      response = await fetch(`${this.url}/${endpoint}`, {
        method: 'POST',
        headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(parameters),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
          : AbortSignal.timeout(timeout),
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new AppError(
        error.name === 'TimeoutError'
          ? 'rclone 请求超时，请检查远程连接。'
          : '无法连接 rclone 服务。',
        502,
      );
    }
    const data = await response.json();
    if (!response.ok) {
      let error = safeError(data.error || 'rclone 请求失败。');
      // 配置接口的错误可能包含用户提交的凭据，逐值移除。
      for (const [key, value] of Object.entries(parameters.parameters ?? {})) {
        if (/pass|secret|token|key|credentials/i.test(key) && String(value).length > 2)
          error = error.split(String(value)).join('***');
      }
      if (typeof parameters.opt?.result === 'string' && parameters.opt.result.length > 2)
        error = error.split(parameters.opt.result).join('***');
      throw new AppError(error, 502);
    }
    return data;
  }

  async providers() {
    if (!this.providerCache) this.providerCache = (await this.call('config/providers')).providers;
    return this.providerCache;
  }

  async stop() {
    this.stopping = true;
    this.ready = false;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }
  }
}
