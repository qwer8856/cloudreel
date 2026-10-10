import { AppError, remoteName, cleanPath } from './validation.mjs';

export const DRIVE_WINDOW = 24 * 3600000;
export const DRIVE_DEFAULT_BUDGET = 700_000_000_000;
export function driveUploadLimit(error = '') {
  // Generic 403, API rate limits and storage-space exhaustion must never rotate accounts.
  return /uploadLimitExceeded|User rate limit exceeded\.[^\n]*userRateLimitExceeded|user has exceeded.*upload|750\s*(?:gb|gib)|upload limit (?:(?:has been )?exceeded|reached)/i.test(
    error,
  );
}
export function validateDriveGroup(input) {
  const name = remoteName(input.name);
  if (!Array.isArray(input.members) || !input.members.length || input.members.length > 20)
    throw new AppError('Google group 需要 1–20 个已授权的账号连接。');
  const members = input.members.map((member) => {
    const remote = remoteName(member.remote),
      budgetBytes = Number(member.budgetBytes);
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1 || budgetBytes > 750_000_000_000)
      throw new AppError('每个账号的 24 小时预算须大于 0 且不超过 750 GB（十进制）。');
    return { remote, budgetBytes };
  });
  if (new Set(members.map((member) => member.remote)).size !== members.length)
    throw new AppError('group 中不能重复添加同一个连接。');
  return { name, members };
}

export class DriveGroups {
  constructor({ state, save, engine, now = Date.now, inspectMember, fetcher = fetch }) {
    Object.assign(this, { state, save, engine, now, fetcher });
    state.driveGroups ||= [];
    state.driveAccounts ||= {};
    this.inspectMember = inspectMember || ((name) => this.googleIdentity(name));
  }
  record(name) {
    return (this.state.driveGroups || []).find((group) => group.name === name);
  }
  member(remote) {
    return (this.state.driveGroups || [])
      .flatMap((group) => group.members)
      .find((member) => member.remote === remote);
  }
  identity(remote) {
    return this.member(remote)?.identity;
  }
  targetKey(remote) {
    const group =
      this.record(remote) ||
      (this.state.driveGroups || []).find((group) =>
        group.members.some((member) => member.remote === remote),
      );
    return group ? `google:${group.teamDrive}:${group.rootId}` : remote;
  }
  budget(identity) {
    const values = (this.state.driveGroups || [])
      .flatMap((group) => group.members)
      .filter((member) => member.identity === identity)
      .map((member) => member.budgetBytes);
    return values.length ? Math.min(...values) : 0;
  }
  account(identity) {
    this.state.driveAccounts ||= {};
    if (!Object.hasOwn(this.state.driveAccounts, identity))
      this.state.driveAccounts[identity] = { buckets: [], cooldownUntil: 0 };
    return this.state.driveAccounts[identity];
  }
  usage(identity) {
    const account = this.account(identity),
      current = this.now();
    account.buckets = account.buckets.filter((bucket) => bucket.until > current);
    return {
      usedBytes: account.buckets.reduce((sum, bucket) => sum + bucket.bytes, 0),
      cooldownUntil: account.cooldownUntil > current ? account.cooldownUntil : 0,
    };
  }
  remaining(identity) {
    const usage = this.usage(identity);
    return usage.cooldownUntil ? 0 : Math.max(0, this.budget(identity) - usage.usedBytes);
  }
  view(group) {
    return {
      name: group.name,
      teamDrive: group.teamDrive,
      rootId: group.rootId,
      members: group.members.map((member) => ({
        ...member,
        ...this.usage(member.identity),
        remainingBytes: this.remaining(member.identity),
        status: this.state.health?.[member.remote]?.status || 'unknown',
      })),
    };
  }
  remoteView(group) {
    return {
      name: group.name,
      type: 'drive-group',
      managed: true,
      virtual: true,
      pending: null,
      parameters: { team_drive: group.teamDrive, root_folder_id: group.rootId },
      capabilities: { read: true, upload: true },
      group: this.view(group),
    };
  }
  async googleIdentity(name) {
    let config = (await this.engine.call('config/dump'))[name];
    if (
      !config ||
      config.type !== 'drive' ||
      !config.team_drive ||
      config.service_account_file ||
      config.service_account_credentials
    )
      throw new AppError(`${name} 必须是已独立 OAuth 授权的 Google 团队盘连接。`);
    if (
      config.scope &&
      !config.scope.split(',').some((scope) => ['drive', 'drive.file'].includes(scope.trim()))
    )
      throw new AppError(`${name} 的 OAuth 范围不支持文件上传，请重新授权。`);
    // A real backend access refreshes expired rclone OAuth tokens before we identify the user.
    await this.engine.call(
      'operations/list',
      { fs: `${name}:`, remote: '', opt: { dirsOnly: true, noModTime: true, noMimeType: true } },
      60000,
    );
    config = (await this.engine.call('config/dump'))[name];
    let token;
    try {
      token = JSON.parse(config.token).access_token;
    } catch {}
    if (!token || this.state.pending?.[name]) throw new AppError(`${name} 尚未完成 Google 授权。`);
    const request = async (url) => {
      let response;
      try {
        response = await this.fetcher(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(20000),
          redirect: 'error',
        });
      } catch {
        throw new AppError(`${name} 的 Google 身份校验请求超时。`, 502);
      }
      if (!response.ok)
        throw new AppError(
          `${name} 的 Google 身份或团队盘权限校验失败（HTTP ${response.status}）。`,
          502,
        );
      return response.json();
    };
    const rootId = config.root_folder_id || config.team_drive;
    const [about, folder] = await Promise.all([
      request(
        'https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress,displayName)',
      ),
      request(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(rootId)}?supportsAllDrives=true&fields=id,driveId,capabilities(canAddChildren)`,
      ),
    ]);
    if (
      !about.user?.permissionId ||
      folder.driveId !== config.team_drive ||
      !folder.capabilities?.canAddChildren
    )
      throw new AppError(`${name} 没有此团队盘目录的上传权限，或根目录不在该团队盘内。`);
    return {
      identity: about.user.permissionId,
      email: about.user.emailAddress || about.user.displayName || name,
      teamDrive: config.team_drive,
      rootId,
    };
  }
  async write(input, existingName) {
    const normalized = validateDriveGroup({ ...input, name: existingName || input.name });
    const existing = existingName ? this.record(existingName) : null;
    if (!existingName && this.state.driveGroups.length >= 50)
      throw new AppError('最多创建 50 个 Google group。', 409);
    if (existingName && !existing) throw new AppError('Google group 不存在。', 404);
    const members = [];
    for (const member of normalized.members) {
      if (this.record(member.remote)) throw new AppError('group 不能嵌套 group。');
      const identity = await this.inspectMember(member.remote);
      if (!identity.identity || !identity.teamDrive || !identity.rootId)
        throw new AppError('Google 账号信息不完整。');
      const old = this.member(member.remote);
      if (old && old.identity !== identity.identity)
        throw new AppError(`${member.remote} 的账号身份已改变，请先从已有 group 移除。`);
      members.push({ ...member, ...identity });
    }
    if (new Set(members.map((member) => member.identity)).size !== members.length)
      throw new AppError('这些连接包含同一个 Google 账号，重复授权不会增加额度。');
    if (new Set(members.map((member) => `${member.teamDrive}:${member.rootId}`)).size !== 1)
      throw new AppError('所有成员必须指向同一个团队盘及同一个根目录。');
    const group = {
      name: normalized.name,
      teamDrive: members[0].teamDrive,
      rootId: members[0].rootId,
      members,
    };
    if (existing && (existing.teamDrive !== group.teamDrive || existing.rootId !== group.rootId))
      throw new AppError('已有 group 不能改为另一个团队盘目录，请新建 group。');
    if (existing) Object.assign(existing, group);
    else this.state.driveGroups.push(group);
    this.state.health ||= {};
    for (const member of members) {
      this.account(member.identity);
      this.state.health[member.remote] = {
        status: 'healthy',
        error: '',
        checkedAt: new Date(this.now()).toISOString(),
      };
    }
    await this.save();
    return this.view(group);
  }
  readMember(name, job) {
    const group = this.record(name);
    if (!group) return name;
    const selected =
      job?.destination?.remote === name &&
      group.members.find((member) => member.remote === job.targetRemote);
    const member =
      selected ||
      group.members.find(
        (member) =>
          !this.state.pending?.[member.remote] &&
          this.state.health?.[member.remote]?.status !== 'auth_required',
      );
    if (!member) throw new AppError('Google group 的所有成员都需要重新授权。');
    return member.remote;
  }
  gate(job, running) {
    const group = this.record(job.destination.remote),
      member = this.member(job.destination.remote);
    if (!group && !member) return null;
    const canonical = this.targetKey(job.destination.remote);
    // Same shared-drive destination and user budget are serialized, including ordinary member jobs.
    if (running.some((item) => this.targetKey(item.destination.remote) === canonical))
      return { status: 'queued', reason: '等待同一 Google 团队盘目录的传输完成' };
    const candidates = (group ? group.members : [member]).filter(
      (item) =>
        !this.state.pending?.[item.remote] &&
        this.state.health?.[item.remote]?.status !== 'auth_required',
    );
    if (!candidates.length) return { status: 'blocked', reason: 'Google group 的成员需要重新授权' };
    const available = candidates.filter((item) => job.dryRun || this.remaining(item.identity) > 0);
    if (!available.length)
      return {
        status: 'waiting_quota',
        reason: '所有 Google 账号的 24 小时额度均已用完，额度恢复后继续',
      };
    const selected = available.find(
      (item) =>
        !running.some(
          (active) =>
            this.identity(active.targetRemote || active.destination.remote) === item.identity,
        ),
    );
    if (!selected) return { status: 'queued', reason: '等待 Google 账号额度的其他传输完成' };
    job.targetRemote = selected.remote;
    job.driveIdentity = selected.identity;
    return null;
  }
  capacity(job) {
    const identity = this.identity(job.targetRemote || job.destination.remote);
    return !job.dryRun && identity ? this.remaining(identity) : null;
  }
  maxFileBudget(remote) {
    const group = this.record(remote),
      member = this.member(remote);
    return group
      ? Math.max(...group.members.map((value) => this.budget(value.identity)))
      : member
        ? this.budget(member.identity)
        : 0;
  }
  accountBytes(job, delta) {
    if (!delta || job.dryRun) return;
    const identity = job.driveIdentity || this.identity(job.destination.remote);
    if (!identity) return;
    const account = this.account(identity);
    // Hourly buckets expire 24h after their last byte, conservatively avoiding early resets.
    const hour = Math.floor(this.now() / 3600000);
    let bucket = account.buckets.find((item) => item.hour === hour);
    if (!bucket) {
      bucket = { hour, bytes: 0, until: 0 };
      account.buckets.push(bucket);
    }
    bucket.bytes += delta;
    bucket.until = this.now() + DRIVE_WINDOW;
    this.usage(identity);
  }
  rotate(job, error, scheduleExhausted = false) {
    if (job.dryRun || job.stopping || !job.driveIdentity) return false;
    const capacity = job.driveCapacity;
    const accountLimit =
      /max transfer limit|transfer limit reached/i.test(error) &&
      capacity != null &&
      capacity === job.limits?.bytes;
    if (!driveUploadLimit(error) && !accountLimit) return false;
    this.account(job.driveIdentity).cooldownUntil = this.now() + DRIVE_WINDOW;
    if (scheduleExhausted) return false;
    const previous = job.targetRemote || job.destination.remote;
    delete job.targetRemote;
    delete job.driveIdentity;
    job.status = this.record(job.destination.remote) ? 'queued' : 'waiting_quota';
    job.error = '';
    job.waitReason = this.record(job.destination.remote)
      ? `Google 账号 ${previous} 上传额度已达限制，正在切换 group 中的下一个账号`
      : `Google 账号 ${previous} 上传额度已达限制，等待 24 小时额度恢复`;
    return true;
  }
  endpoint(endpoint, job) {
    const remote = this.readMember(endpoint.remote, job);
    return { remote, path: cleanPath(endpoint.path) };
  }
}
