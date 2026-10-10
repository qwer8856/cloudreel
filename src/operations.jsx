import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Users, RefreshCw, Pause, Play, Download, ShieldCheck } from 'lucide-react';
import { api, bytes, time, providerInfo } from './api.js';
import { Badge, Dialog, JobTable, ProviderBadge } from './components.jsx';
import './operations.css';
import { DriveGroupSummary } from './connections.jsx';

const pending = ['running', 'queued', 'retry_wait', 'waiting_quota', 'blocked'];
function NumberField({ label, value, onChange, min = 0, max = 86400 }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        required
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
export function AccountsPage({ remotes, openRemote, notify, refresh }) {
  const [data, setData] = useState(null),
    [editing, setEditing] = useState(null),
    [error, setError] = useState('');
  const load = useCallback(
    () =>
      api('/operations')
        .then(setData)
        .catch((error) => setError(error.message)),
    [],
  );
  useEffect(() => {
    load();
  }, [load, remotes]);
  const done = async () => {
    setEditing(null);
    await load();
    refresh();
  };
  return (
    <>
      <div className="page-title">
        <div>
          <h1>账号与额度</h1>
          <p>同一种网盘可连接多个账号，每个连接独立保存授权。</p>
        </div>
        <button className="button primary" onClick={() => openRemote()}>
          <Plus size={16} />
          添加账号
        </button>
      </div>
      <div className="ops-info">
        不同账号使用不同的连接名称，例如
        115-main、115-backup。同一账号的多个连接可以绑定同一额度组；同组任务依次执行，已用额度按组累计。
      </div>
      {error && <p className="form-error">{error}</p>}
      {data && (
        <>
          <section className="panel ops-panel">
            <div className="ops-toolbar">
              <h3>Google 团队盘 group</h3>
              <button className="button secondary" onClick={() => openRemote(null, 'drive-group')}>
                <Plus size={15} />
                新建 Google group
              </button>
            </div>
            {!remotes.some((remote) => remote.type === 'drive-group') && (
              <p className="muted">
                将指向同一个团队盘的独立账号组成一个连接，按各自 24 小时预算切换上传账号。
              </p>
            )}
            {remotes
              .filter((remote) => remote.type === 'drive-group')
              .map((remote) => (
                <div key={remote.name} className="drive-group-card">
                  <div className="ops-toolbar">
                    <strong>{remote.name}</strong>
                    <button className="text-button" onClick={() => openRemote(remote)}>
                      编辑
                    </button>
                    <button
                      className="text-button danger"
                      onClick={async () => {
                        try {
                          await api(`/remotes/${encodeURIComponent(remote.name)}`, {
                            method: 'DELETE',
                            body: {},
                          });
                          refresh();
                        } catch (error) {
                          notify(error.message, 'error');
                        }
                      }}
                    >
                      删除
                    </button>
                  </div>
                  <DriveGroupSummary group={remote.group} />
                </div>
              ))}
          </section>
          <section className="panel ops-panel">
            <div className="ops-toolbar">
              <h3>共享每日额度</h3>
              <button className="button secondary" onClick={() => setEditing({})}>
                <Plus size={15} />
                新建额度组
              </button>
            </div>
            {!data.groups.length && (
              <p className="muted">尚未设置共享额度。账号也可以仅限制并发。</p>
            )}
            {data.groups.map((group) => (
              <div className="ops-toolbar" key={group.id}>
                <strong>{group.name}</strong>
                <span className="ops-muted">
                  今日 {bytes(group.today.bytes)} / {bytes(group.dailyBytes)} · {group.timezone}
                </span>
                <button className="text-button" onClick={() => setEditing(group)}>
                  编辑
                </button>
                <button
                  className="text-button danger"
                  onClick={async () => {
                    try {
                      await api(`/quota-groups/${group.id}`, { method: 'DELETE', body: {} });
                      await load();
                    } catch (error) {
                      notify(error.message, 'error');
                    }
                  }}
                >
                  删除
                </button>
              </div>
            ))}
          </section>
          <div className="ops-grid">
            {[{ name: 'local', type: 'local' }, ...remotes].map((remote) => (
              <AccountCard
                key={remote.name}
                remote={remote}
                policy={
                  data.policies[remote.name] || {
                    label: remote.name === 'local' ? '本地文件' : remote.name,
                    groupId: '',
                    maxJobs: remote.managed ? 1 : 2,
                    healthPath: '',
                  }
                }
                groups={data.groups}
                health={data.health[remote.name]}
                onDone={done}
                notify={notify}
                openRemote={openRemote}
              />
            ))}
          </div>
        </>
      )}
      {editing && <GroupForm group={editing} onClose={() => setEditing(null)} onDone={done} />}
    </>
  );
}
function AccountCard({ remote, policy, groups, health, onDone, notify, openRemote }) {
  const [values, setValues] = useState(policy),
    [busy, setBusy] = useState(false);
  useEffect(
    () => setValues(policy),
    [policy.label, policy.groupId, policy.maxJobs, policy.healthPath],
  );
  const change = (key, value) => setValues((previous) => ({ ...previous, [key]: value }));
  const action = async (operation) => {
    setBusy(true);
    try {
      await operation();
      await onDone();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel ops-panel">
      <div className="ops-account-header">
        <ProviderBadge type={remote.type} />
        <div>
          <h3>{policy.label}</h3>
          <span className="muted">
            {providerInfo(remote.type).title} · {remote.name}
          </span>
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          action(() =>
            api(`/accounts/${encodeURIComponent(remote.name)}`, { method: 'PUT', body: values }),
          );
        }}
      >
        <label className="field">
          <span>账号显示名</span>
          <input
            required
            maxLength={80}
            value={values.label}
            onChange={(event) => change('label', event.target.value)}
          />
        </label>
        <div className="ops-grid">
          <NumberField
            label="同时运行的任务数"
            min={1}
            max={8}
            value={values.maxJobs}
            onChange={(value) => change('maxJobs', value)}
          />
          <label className="field">
            <span>共享额度组</span>
            <select
              value={values.groupId}
              onChange={(event) => change('groupId', event.target.value)}
            >
              <option value="">不限制共享额度</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>健康检查目录</span>
          <input
            value={values.healthPath}
            placeholder="留空检查根目录；S3 可填写桶名"
            onChange={(event) => change('healthPath', event.target.value)}
          />
        </label>
        <p className="ops-muted">
          {health
            ? `${{ healthy: '连接正常', auth_required: '需要重新授权', unavailable: '暂时不可用' }[health.status]} · ${time(health.checkedAt)}`
            : '尚未检查连接'}
          {health?.error && <span className="block">{health.error}</span>}
        </p>
        <div className="ops-toolbar">
          <button className="button primary" disabled={busy}>
            保存账号设置
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || Boolean(remote.pending)}
            onClick={() =>
              action(() =>
                api(`/accounts/${encodeURIComponent(remote.name)}/check`, {
                  method: 'POST',
                  body: {},
                }),
              )
            }
          >
            检查连接
          </button>
          {remote.name !== 'local' && (
            <button type="button" className="text-button" onClick={() => openRemote(remote)}>
              登录 / 授权
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
function GroupForm({ group, onClose, onDone }) {
  const [values, setValues] = useState({
      name: group.name || '',
      volume: group.dailyBytes ? group.dailyBytes / 1024 ** 3 : 100,
      timezone: group.timezone || 'Asia/Shanghai',
      cutoffMode: group.cutoffMode || 'hard',
    }),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <Dialog title={group.id ? '编辑共享额度' : '新建共享额度'} onClose={busy ? () => {} : onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await api(group.id ? `/quota-groups/${group.id}` : '/quota-groups', {
              method: group.id ? 'PUT' : 'POST',
              body: { ...values, dailyBytes: Math.round(values.volume * 1024 ** 3) },
            });
            await onDone();
          } catch (error) {
            setError(error.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          <label className="field">
            <span>额度组名称</span>
            <input
              required
              maxLength={80}
              value={values.name}
              onChange={(event) => setValues({ ...values, name: event.target.value })}
            />
          </label>
          <label className="field">
            <span>每日容量（GiB）</span>
            <input
              required
              type="number"
              min="0.000001"
              step="any"
              value={values.volume}
              onChange={(event) => setValues({ ...values, volume: Number(event.target.value) })}
            />
          </label>
          <label className="field">
            <span>时区</span>
            <input
              required
              disabled={Boolean(group.today?.bytes)}
              value={values.timezone}
              onChange={(event) => setValues({ ...values, timezone: event.target.value })}
            />
          </label>
          <label className="field">
            <span>额度用完后</span>
            <select
              value={values.cutoffMode}
              onChange={(event) => setValues({ ...values, cutoffMode: event.target.value })}
            >
              <option value="hard">立即停止</option>
              <option value="soft">完成正在传输的文件后停止</option>
            </select>
          </label>
          <p className="muted">
            按此时区午夜重置。重试和重启保留当天用量；完成当前文件可能超过额度。
          </p>
          {error && <p className="form-error">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            保存
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
export function QueuePage({ jobs, status, openJob, onStop, notify, refresh, initialJobId }) {
  const [detail, setDetail] = useState(initialJobId || null),
    [filter, setFilter] = useState('all');
  useEffect(() => {
    if (initialJobId) setDetail(initialJobId);
  }, [initialJobId]);
  const list = jobs.filter(
    (job) =>
      filter === 'all' ||
      (filter === 'pending'
        ? pending.includes(job.status) || job.status === 'paused'
        : !pending.includes(job.status) && job.status !== 'paused'),
  );
  return (
    <>
      <div className="page-title">
        <div>
          <h1>传输任务</h1>
          <p>任务持久保存，按账号并发和每日额度依次运行。</p>
        </div>
        <button className="button primary" disabled={!status?.available} onClick={() => openJob()}>
          <Plus size={16} />
          新建任务
        </button>
      </div>
      <div className="task-summary">
        <span>{jobs.filter((job) => job.status === 'running').length} 个运行中</span>
        <span>
          {jobs.filter((job) => pending.includes(job.status) && job.status !== 'running').length}{' '}
          个等待中
        </span>
        <span>{jobs.filter((job) => job.status === 'completed').length} 个已完成</span>
      </div>
      <section className="panel">
        <div className="tabs">
          {[
            ['all', '全部任务'],
            ['pending', '队列与暂停'],
            ['finished', '已结束'],
          ].map(([key, label]) => (
            <button
              key={key}
              className={filter === key ? 'active' : ''}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <JobTable jobs={list} onStop={onStop} onDetails={(job) => setDetail(job.id)} />
      </section>
      <div className="page-note">
        已完成文件会重新检查并跳过；中断文件能否断点续传取决于存储后端。
      </div>
      {detail && (
        <JobDetails id={detail} onClose={() => setDetail(null)} notify={notify} refresh={refresh} />
      )}
    </>
  );
}
function JobDetails({ id, onClose, notify, refresh }) {
  const [job, setJob] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = useCallback(
    () =>
      api(`/jobs/${id}`)
        .then(setJob)
        .catch((error) => setError(error.message)),
    [id],
  );
  useEffect(() => {
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [load]);
  const action = async (path, body = {}) => {
    setBusy(true);
    try {
      await api(`/jobs/${id}/${path}`, { method: 'POST', body });
      await load();
      refresh();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const [fileFilter, setFileFilter] = useState('all'),
    [filePage, setFilePage] = useState(0);
  const files = (job?.files || []).filter(
    (file) => fileFilter === 'all' || file.status === fileFilter,
  );
  const pageCount = Math.max(1, Math.ceil(files.length / 100));
  const selectedPage = Math.min(filePage, pageCount - 1);
  return (
    <Dialog
      wide
      title={job?.name || '任务详情'}
      subtitle="传输明细、执行记录与完整性校验。"
      onClose={onClose}
    >
      <div className="modal-body">
        {job && (
          <>
            <div className="ops-toolbar">
              <Badge status={job.status} />
              {job.stats?.conflicts > 0 && (
                <span className="ops-warning">
                  有 {job.stats.conflicts} 个同名冲突，已保留目标文件
                </span>
              )}
              <span className="muted">
                累计 {bytes(job.transferredBytes || job.stats?.bytes)} · 已执行 {job.attempts || 0}{' '}
                次
              </span>
            </div>
            {job.waitReason && (
              <p className="ops-warning">
                {job.waitReason}
                {job.retryAt && ` · ${time(job.retryAt)}`}
              </p>
            )}
            {job.reason && (
              <p className="muted" role="status">
                {job.reason}
              </p>
            )}
            {job.error && <p className="form-error">{job.error}</p>}
            {job.status === 'running' && job.pollError && (
              <p className="ops-warning" role="status">
                进度更新失败：{job.pollError}。当前显示可能不是最新进度。
              </p>
            )}
            {job.status === 'running' && job.stats?.lastError && (
              <p className="ops-warning" role="status">
                本次执行最近请求错误：{job.stats.lastError}
                {job.stats.errors > 0 && `（累计 ${job.stats.errors} 个错误）`}
                。任务尚未结束，此记录不一定属于当前文件。
              </p>
            )}
            {job.rawError && (
              <details className="transfer-diagnostic">
                <summary>查看停止时的技术记录</summary>
                <p>{job.rawError}</p>
              </details>
            )}
            <div className="ops-toolbar">
              {pending.includes(job.status) && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => action('pause')}
                >
                  <Pause size={15} />
                  暂停
                </button>
              )}
              {['paused', 'blocked', 'failed', 'stopped', 'interrupted'].includes(job.status) && (
                <button
                  className="button primary"
                  disabled={busy || job.verification?.status === 'running'}
                  onClick={() => action('resume')}
                >
                  <Play size={15} />
                  恢复任务
                </button>
              )}
              {!pending.includes(job.status) && (
                <button
                  className="button secondary"
                  disabled={busy || job.verification?.status === 'running'}
                  onClick={() => action('retry-files')}
                >
                  <RefreshCw size={15} />
                  只重试失败文件
                </button>
              )}
              <a className="button secondary" href={`/api/jobs/${id}/export`} download>
                <Download size={15} />
                导出明细
              </a>
            </div>
            <h3>文件明细</h3>
            {job.files.some((file) => file.status === 'checked') && (
              <p className="muted">
                “已检查”是 rclone 的比较记录，不代表跳过或传输成功。真实跳过和失败会在“原因 /
                错误”中说明。
              </p>
            )}
            <div className="ops-toolbar">
              <label className="field">
                <span>显示文件</span>
                <select
                  value={fileFilter}
                  onChange={(event) => {
                    setFileFilter(event.target.value);
                    setFilePage(0);
                  }}
                >
                  <option value="all">全部（{job.files.length}）</option>
                  <option value="pending">等待传输</option>
                  <option value="running">正在传输</option>
                  <option value="completed">成功</option>
                  <option value="failed">失败</option>
                  <option value="skipped">跳过</option>
                  <option value="checked">已检查</option>
                  <option value="stopped">已停止</option>
                </select>
              </label>
              {job.currentFile && <span className="muted">当前：{job.currentFile}</span>}
            </div>
            {job.mediaPreparing && (
              <p className="ops-warning" aria-live="polite">
                正在后台扫描来源：已读取 {job.scanProgress?.progress.directoriesDone || 0}{' '}
                个目录，发现 {job.scanProgress?.progress.filesFound || 0} 个文件
                {job.scanProgress?.currentPath && ` · 当前目录：${job.scanProgress.currentPath}`}。
                可以暂停或停止任务。
              </p>
            )}
            {job.detailsTruncated && (
              <p className="ops-warning">明细记录已截断；完整重跑会重新检查并跳过已完成文件。</p>
            )}
            <div className="ops-log">
              <table className="transfer-files">
                <thead>
                  <tr>
                    <th>文件</th>
                    <th>目标路径</th>
                    <th>状态</th>
                    <th>大小</th>
                    <th>进度 / 检查</th>
                    <th>原因 / 错误</th>
                  </tr>
                </thead>
                <tbody>
                  {files.slice(selectedPage * 100, (selectedPage + 1) * 100).map((file) => (
                    <tr key={file.key}>
                      <td>{file.path}</td>
                      <td>{file.targetFile || file.path}</td>
                      <td>
                        {
                          {
                            pending: '等待传输',
                            running:
                              {
                                waiting: '等待连接 / 读取',
                                finishing: '等待完成确认',
                              }[file.progressPhase] || '正在传输',
                            planned: '预演',
                            completed: '成功',
                            failed: '失败',
                            skipped: '跳过',
                            checked: '已检查',
                            stopped: '已停止',
                            deleted: '删除',
                          }[file.status]
                        }
                      </td>
                      <td>{bytes(file.size)}</td>
                      <td>
                        {file.status === 'running' ? (
                          <>
                            {bytes(file.bytes)} / {bytes(file.size)}
                            {!job.stopping && file.idleSeconds >= 60 && (
                              <p className="transfer-idle">已 {file.idleSeconds} 秒无字节进展</p>
                            )}
                          </>
                        ) : (
                          {
                            same_size: '大小一致',
                            hash_match: '哈希一致',
                            different: '同名内容不同',
                            directory: '目标是目录',
                          }[file.check] || '—'
                        )}
                      </td>
                      <td>
                        {file.reason ||
                          file.error ||
                          (file.status === 'running' && !job.stopping && file.idleSeconds >= 60
                            ? '可能在等待连接、读取或重试；具体原因请查看本次执行的请求错误。'
                            : '—')}
                        {file.rawError && file.rawError !== (file.reason || file.error) && (
                          <details className="transfer-diagnostic">
                            <summary>技术记录</summary>
                            <p>{file.rawError}</p>
                          </details>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!job.files.length && (
                <p className="muted">尚无文件明细；运行中的文件将在完成后记录。</p>
              )}
            </div>
            {files.length > 100 && (
              <div className="ops-toolbar">
                <button
                  className="button secondary"
                  disabled={!selectedPage}
                  onClick={() => setFilePage(selectedPage - 1)}
                >
                  上一页
                </button>
                <span>
                  {selectedPage + 1} / {pageCount} 页 · {files.length} 个文件
                </span>
                <button
                  className="button secondary"
                  disabled={selectedPage + 1 >= pageCount}
                  onClick={() => setFilePage(selectedPage + 1)}
                >
                  下一页
                </button>
              </div>
            )}
            <h3>传输后校验</h3>
            <p className="muted">
              大小校验不读取文件内容。哈希校验使用双方支持的共同哈希；不支持时仅比较大小，不额外下载整个文件。
            </p>
            <div className="ops-toolbar">
              <button
                className="button secondary"
                disabled={
                  busy || pending.includes(job.status) || job.verification?.status === 'running'
                }
                onClick={() => action('verify', { mode: 'size' })}
              >
                校验文件大小
              </button>
              <button
                className="button secondary"
                disabled={
                  busy || pending.includes(job.status) || job.verification?.status === 'running'
                }
                onClick={() => action('verify', { mode: 'hash' })}
              >
                <ShieldCheck size={15} />
                校验哈希
              </button>
              {job.verification?.status === 'running' && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => action('verify/stop')}
                >
                  停止校验
                </button>
              )}
            </div>
            {job.verification && (
              <div className="ops-info">
                <strong>
                  校验：
                  {
                    {
                      running: '运行中',
                      completed: '一致',
                      failed: '发现差异或失败',
                      interrupted: '已中断',
                    }[job.verification.status]
                  }
                </strong>
                {job.verification.report?.hashType && (
                  <p>哈希类型：{job.verification.report.hashType}</p>
                )}
                {job.verification.report?.checked !== undefined ? (
                  <>
                    <p>
                      已检查 {job.verification.report.checked} 个文件：
                      {job.verification.report.hashChecked} 个哈希检查，
                      {job.verification.report.sizeChecked} 个大小检查。
                    </p>
                    <p>
                      差异 {job.verification.report.differ.length} 个，缺失{' '}
                      {job.verification.report.missingOnDst.length} 个，无法检查{' '}
                      {job.verification.report.error.length} 个。
                    </p>
                    {[
                      ...job.verification.report.differ,
                      ...job.verification.report.missingOnDst,
                      ...job.verification.report.error,
                    ]
                      .slice(0, 100)
                      .map((item, index) => (
                        <p key={index}>{item}</p>
                      ))}
                  </>
                ) : (
                  <div className="ops-log">
                    <pre>
                      {JSON.stringify(
                        job.verification.report || { error: job.verification.error },
                        null,
                        2,
                      )}
                    </pre>
                  </div>
                )}
              </div>
            )}
            <h3>执行记录</h3>
            <div className="ops-log">
              {job.events.map((event, index) => (
                <p key={index}>
                  <small className="muted">{time(event.at)}</small> {event.message}
                </p>
              ))}
            </div>
          </>
        )}
        {error && <p className="form-error">{error}</p>}
      </div>
      <footer className="modal-footer">
        <button className="button secondary" onClick={onClose}>
          关闭
        </button>
      </footer>
    </Dialog>
  );
}
export function ManagementPage({ notify, refresh }) {
  const [settings, setSettings] = useState(null),
    [error, setError] = useState('');
  useEffect(() => {
    api('/operations')
      .then((data) => setSettings(data.settings))
      .catch((error) => setError(error.message));
  }, []);
  return (
    <>
      <div className="page-title">
        <div>
          <h1>通知与备份</h1>
          <p>设置任务队列、运行通知与完整配置恢复。</p>
        </div>
      </div>
      {error && <p className="form-error">{error}</p>}
      {settings && <QueueSettings initial={settings} notify={notify} />}
      <NotificationForm notify={notify} />
      <BackupForm notify={notify} refresh={refresh} />
    </>
  );
}
function QueueSettings({ initial, notify }) {
  const [values, setValues] = useState(initial),
    [busy, setBusy] = useState(false);
  const change = (key, value) => setValues((previous) => ({ ...previous, [key]: value }));
  return (
    <section className="panel ops-panel">
      <h3>队列与自动恢复</h3>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await api('/operations', { method: 'PUT', body: values });
            notify('队列设置已保存');
          } catch (error) {
            notify(error.message, 'error');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="ops-grid">
          {[
            ['maxJobs', '全局同时运行任务数', 1, 8],
            ['maxRetries', '自动重试次数', 0, 20],
            ['retryDelaySeconds', '首次重试等待（秒）', 1, 3600],
            ['maxDelaySeconds', '最长重试等待（秒）', 1, 86400],
            ['healthMinutes', '账号健康检查间隔（分钟）', 1, 1440],
          ].map(([key, label, min, max]) => (
            <NumberField
              key={key}
              label={label}
              value={values[key]}
              min={min}
              max={max}
              onChange={(value) => change(key, value)}
            />
          ))}
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={values.autoResume}
            onChange={(event) => change('autoResume', event.target.checked)}
          />
          <span>服务重启后自动继续未完成的普通任务</span>
        </label>
        <div className="ops-toolbar">
          <button className="button primary" disabled={busy}>
            保存队列设置
          </button>
        </div>
      </form>
    </section>
  );
}
function NotificationForm({ notify }) {
  const [values, setValues] = useState(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api('/notifications')
      .then((value) => setValues({ ...value, url: '', token: '' }))
      .catch((error) => notify(error.message, 'error'));
  }, [notify]);
  if (!values) return null;
  const action = async (test) => {
    setBusy(true);
    try {
      if (test) {
        await api('/notifications/test', { method: 'POST', body: {} });
        notify('测试通知已发送');
      } else {
        const view = await api('/notifications', { method: 'PUT', body: values });
        setValues({ ...view, url: '', token: '' });
        notify('通知设置已保存');
      }
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel ops-panel">
      <h3>任务通知</h3>
      <p className="muted">启用后，任务名称、结果及传输字节数会发送到你设置的接收方。</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          action(false);
        }}
      >
        <label className="checkbox">
          <input
            type="checkbox"
            checked={values.enabled}
            onChange={(event) => setValues({ ...values, enabled: event.target.checked })}
          />
          <span>启用通知</span>
        </label>
        <label className="field">
          <span>通知渠道</span>
          <select
            value={values.channel}
            onChange={(event) => setValues({ ...values, channel: event.target.value })}
          >
            <option value="webhook">Webhook</option>
            <option value="telegram">Telegram</option>
          </select>
        </label>
        {values.channel === 'webhook' ? (
          <label className="field">
            <span>Webhook 地址</span>
            <input
              type="password"
              autoComplete="new-password"
              placeholder={values.urlSaved ? '已保存，留空保留' : 'https://…'}
              value={values.url}
              onChange={(event) => setValues({ ...values, url: event.target.value })}
            />
          </label>
        ) : (
          <div className="ops-grid">
            <label className="field">
              <span>Bot Token</span>
              <input
                type="password"
                autoComplete="new-password"
                placeholder={values.tokenSaved ? '已保存，留空保留' : '输入机器人令牌'}
                value={values.token}
                onChange={(event) => setValues({ ...values, token: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Chat ID</span>
              <input
                value={values.chatId}
                onChange={(event) => setValues({ ...values, chatId: event.target.value })}
              />
            </label>
          </div>
        )}
        <div className="ops-toolbar">
          {[
            ['completed', '完成'],
            ['failed', '失败'],
            ['quota', '每日额度用完'],
            ['auth', '授权失效'],
          ].map(([key, label]) => (
            <label className="checkbox" key={key}>
              <input
                type="checkbox"
                checked={values.events.includes(key)}
                onChange={(event) =>
                  setValues({
                    ...values,
                    events: event.target.checked
                      ? [...values.events, key]
                      : values.events.filter((value) => value !== key),
                  })
                }
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <div className="ops-toolbar">
          <button className="button primary" disabled={busy}>
            保存通知设置
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || !values.enabled}
            onClick={() => action(true)}
          >
            发送测试通知
          </button>
        </div>
      </form>
      {values.history.slice(0, 5).map((item, index) => (
        <p className="ops-muted" key={index}>
          {time(item.at)} · {item.status === 'sent' ? '已发送' : '发送失败'} {item.error}
        </p>
      ))}
    </section>
  );
}
function BackupForm({ notify, refresh }) {
  const [passphrase, setPassphrase] = useState(''),
    [archive, setArchive] = useState(null),
    [info, setInfo] = useState(null),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false);
  const action = async (kind) => {
    setBusy(true);
    try {
      if (kind === 'export') {
        const result = await api('/backups/export', { method: 'POST', body: { passphrase } });
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(result)], { type: 'application/json' }),
        );
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `cloudreel-backup-${new Date().toISOString().slice(0, 10)}.json`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setPassphrase('');
        notify('加密备份已下载');
      } else if (kind === 'inspect') {
        setInfo(await api('/backups/inspect', { method: 'POST', body: { archive, passphrase } }));
      } else {
        await api('/backups/restore', {
          method: 'POST',
          body: { archive, passphrase, confirmRestore: confirmed },
        });
        setPassphrase('');
        setInfo(null);
        setConfirmed(false);
        await refresh(true);
        notify('配置已恢复，任务与通知保持暂停');
      }
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel ops-panel">
      <h3>完整加密备份与恢复</h3>
      <p className="muted">
        包含 rclone 配置、任务与额度记录，以及本面板管理的 OpenList 网盘挂载和授权。使用 AES-256-GCM
        加密；文件内容需另外备份。操作前请暂停队列并停用计划。
      </p>
      <label className="field">
        <span>备份密码，至少 12 位</span>
        <input
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={passphrase}
          onChange={(event) => {
            setPassphrase(event.target.value);
            setInfo(null);
            setConfirmed(false);
          }}
        />
      </label>
      <div className="ops-toolbar">
        <button
          className="button primary"
          disabled={busy || passphrase.length < 12}
          onClick={() => action('export')}
        >
          <Download size={16} />
          导出完整备份
        </button>
      </div>
      <label className="field">
        <span>选择备份文件</span>
        <input
          type="file"
          accept=".json,application/json"
          onChange={async (event) => {
            setInfo(null);
            setConfirmed(false);
            try {
              const file = event.target.files[0];
              if (!file) return;
              if (file.size > 90 * 1024 * 1024) throw new Error('备份文件超过 90 MiB。');
              setArchive(JSON.parse(await file.text()));
            } catch (error) {
              setArchive(null);
              notify(error.message, 'error');
            }
          }}
        />
      </label>
      <button
        className="button secondary"
        disabled={busy || !archive || passphrase.length < 12}
        onClick={() => action('inspect')}
      >
        验证备份文件
      </button>
      {info && (
        <div className="ops-info">
          <strong>备份有效 · {time(info.createdAt)}</strong>
          <p>
            {info.remotes.length} 个连接，{info.cloudAccounts} 个网盘账号，{info.schedules} 个计划，
            {info.jobs} 条任务记录。
          </p>
          <p className="muted">
            网盘挂载将恢复到当前已连接的 OpenList 服务。原配置会先保存为加密恢复点。
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>确认覆盖当前配置，以暂停状态恢复全部任务。</span>
          </label>
          <button
            className="button primary"
            disabled={busy || !confirmed}
            onClick={() => action('restore')}
          >
            恢复配置
          </button>
        </div>
      )}
    </section>
  );
}
