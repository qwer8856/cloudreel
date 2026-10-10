import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  CalendarClock,
  Check,
  Clock3,
  HardDrive,
  Files,
  RefreshCw,
  Pause,
  Pencil,
  Play,
  Plus,
  Timer,
  Trash2,
} from 'lucide-react';
import { api, bytes, providerInfo } from './api.js';
import { TransferHint } from './cloud.jsx';
import { ConfirmDialog, Dialog, Empty, Spinner } from './components.jsx';
import { TransferControls, emptyTransferOptions } from './transfer-controls.jsx';
import { MediaOptionsFields, defaultMediaOptions } from './media.jsx';
import './schedules.css';

const labels = {
  running: '运行中',
  queued: '等待传输槽位',
  retry_wait: '等待自动重试',
  blocked: '需要重新授权',
  waiting_quota: '等待共享额度',
  shared_limit: '共享额度已达 · 等待次日',
  waiting: '等待开始',
  interrupted: '等待恢复',
  completed: '今日已完成',
  bytes_limit: '容量已达 · 等待次日',
  time_limit: '时长已达 · 等待次日',
  failed: '运行失败',
  disabled: '已停用',
  paused: '已暂停 · 等待次日',
  rollover: '已跨日',
};
const capacity = (value) => bytes(value).replace(/\b(K|M|G|T|P)B\b/g, '$1iB');
const duration = (value) => {
  const seconds = Math.floor(value || 0);
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`;
};

function Quota({ icon: Icon, title, used, limit, format }) {
  return (
    <div className="schedule-quota">
      <span>
        <Icon size={15} />
        {title}
      </span>
      <div>
        <strong>{format(used)}</strong>
        <small> / {limit ? format(limit) : '不限'}</small>
      </div>
      <div className="progress-track">
        <span style={{ width: `${limit ? Math.min(100, (used / limit) * 100) : 0}%` }} />
      </div>
    </div>
  );
}

export function SchedulesPage({ schedules, remotes, status, refresh, notify, openJob }) {
  const [editor, setEditor] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState('');
  async function action(schedule, operation, body, message) {
    setBusy(schedule.id);
    try {
      await api(`/schedules/${schedule.id}/${operation}`, { method: 'POST', body });
      notify(message);
      await refresh();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setBusy('');
    }
  }
  return (
    <>
      <div className="page-title">
        <div>
          <h1>计划任务</h1>
          <p>按时间与每日额度，持续把影视文件传到目标网盘。</p>
        </div>
        <button
          className="button primary"
          disabled={!status?.available}
          onClick={() => setEditor({})}
        >
          <Plus size={16} />
          新建计划
        </button>
      </div>
      <div className="schedule-intro">
        <span className="schedule-intro-icon">
          <CalendarClock size={25} />
        </span>
        <div>
          <strong>定时增量传输，多个来源共用每日额度</strong>
          <p>每天按时开始，也可定期扫描新增文件。容量与时长先达到一项即停止；源文件保留。</p>
        </div>
      </div>
      <div className="task-summary">
        <span>
          <i className="green-dot" />
          {schedules.filter((s) => s.enabled).length} 个已启用
        </span>
        <span>
          <Play size={15} />
          {schedules.filter((s) => s.status === 'running').length} 个运行中
        </span>
        <span>
          <Clock3 size={15} />
          {schedules.filter((s) => ['bytes_limit', 'time_limit'].includes(s.status)).length}{' '}
          个等待次日
        </span>
      </div>
      {!schedules.length ? (
        <section className="panel">
          <Empty
            icon={CalendarClock}
            title="为传输安排一个日程"
            text="选择源和目标目录，设定每天的开始时间与额度。"
            action={
              <button
                className="button secondary"
                disabled={!status?.available}
                onClick={() => setEditor({})}
              >
                <Plus size={16} />
                创建第一个计划
              </button>
            }
          />
        </section>
      ) : (
        <div className="schedule-grid">
          {schedules.map((schedule) => (
            <section className="panel schedule-card" key={schedule.id}>
              <div className="schedule-heading">
                <span className="schedule-icon">
                  <CalendarClock size={21} />
                </span>
                <div>
                  <h3>{schedule.name}</h3>
                  <p>
                    每天 {schedule.startTime} · {schedule.timezone}
                    {schedule.scanIntervalMinutes > 0 &&
                      ` · 每 ${schedule.scanIntervalMinutes} 分钟检查`}
                  </p>
                </div>
                <span className={`schedule-status ${schedule.status}`}>
                  {labels[schedule.status] || schedule.status}
                </span>
              </div>
              <div className="schedule-paths">
                <div>
                  <small>
                    {schedule.sourcePaths?.length
                      ? `${schedule.sourcePaths.length} 个来源目录`
                      : schedule.mode === 'sync'
                        ? '同步源'
                        : '复制源'}
                  </small>
                  <span
                    title={(schedule.sourcePaths?.length
                      ? schedule.sourcePaths
                      : [schedule.source.path]
                    )
                      .map((path) => `${schedule.source.remote}:${path || '/'}`)
                      .join('\n')}
                  >
                    {schedule.source.remote}:
                    {schedule.sourcePaths?.length
                      ? schedule.sourcePaths.join('、')
                      : schedule.source.path || '/'}
                  </span>
                </div>
                <ArrowRight size={17} />
                <div>
                  <small>目标目录</small>
                  <span title={`${schedule.destination.remote}:${schedule.destination.path}`}>
                    {schedule.destination.remote}:{schedule.destination.path || '/'}
                  </span>
                </div>
              </div>
              <div className="schedule-quotas">
                <Quota
                  icon={HardDrive}
                  title="今日已传输"
                  used={schedule.today.bytes}
                  limit={schedule.dailyBytes}
                  format={capacity}
                />
                <Quota
                  icon={Timer}
                  title="今日运行时长"
                  used={schedule.today.seconds}
                  limit={schedule.dailySeconds}
                  format={duration}
                />
              </div>
              <div className="schedule-next">
                <Clock3 size={14} />
                <span>
                  {schedule.enabled
                    ? schedule.readyNow
                      ? '已到开始时间，等待启动'
                      : schedule.runningJobId
                        ? '本轮正在传输'
                        : `下次${schedule.scanIntervalMinutes > 0 ? '扫描' : '开始'}：${schedule.nextRun || '等待本轮完成'}`
                    : '启用后恢复每日调度'}
                  <small>
                    {schedule.cutoffMode === 'soft'
                      ? '完成当前文件后停止，可能超过额度'
                      : '达到限制立即停止'}
                  </small>
                </span>
              </div>
              {schedule.status === 'failed' && schedule.error && (
                <p className="form-error" role="alert">
                  {schedule.error}
                </p>
              )}
              <div className="schedule-actions">
                <button
                  className="button small-button secondary"
                  disabled={
                    busy === schedule.id ||
                    !status?.available ||
                    schedule.status === 'running' ||
                    ['bytes_limit', 'time_limit'].includes(schedule.status) ||
                    (schedule.dailyBytes && schedule.today.bytes >= schedule.dailyBytes) ||
                    (schedule.dailySeconds && schedule.today.seconds >= schedule.dailySeconds)
                  }
                  onClick={() => action(schedule, 'run', {}, '计划已开始，今日累计额度继续生效')}
                >
                  <Play size={14} />
                  立即运行
                </button>
                <button
                  className="text-button"
                  disabled={busy === schedule.id}
                  onClick={() =>
                    action(
                      schedule,
                      'toggle',
                      { enabled: !schedule.enabled },
                      schedule.enabled
                        ? '计划已停用，正在结束当前任务'
                        : '计划已启用，按剩余额度运行',
                    )
                  }
                >
                  {schedule.enabled ? <Pause size={14} /> : <Check size={14} />}
                  {schedule.enabled ? '停用' : '启用'}
                </button>
                {openJob &&
                  (schedule.runningJobId || schedule.latestJobId || schedule.lastJobId) && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        openJob(schedule.runningJobId || schedule.latestJobId || schedule.lastJobId)
                      }
                    >
                      <Files size={14} />
                      查看文件
                    </button>
                  )}
                <div className="schedule-edit-actions">
                  <button
                    className="icon-button"
                    title="编辑计划"
                    aria-label={`编辑 ${schedule.name}`}
                    disabled={schedule.status === 'running' || busy === schedule.id}
                    onClick={() => setEditor(schedule)}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    className="icon-button danger"
                    title="删除计划"
                    aria-label={`删除 ${schedule.name}`}
                    disabled={schedule.status === 'running' || busy === schedule.id}
                    onClick={() => setDeleting(schedule)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            </section>
          ))}
        </div>
      )}
      <div className="page-note">
        <Clock3 size={15} />
        <span>
          额度按计划时区在午夜重置；多个来源、重复扫描、重试和重启共同累计今日用量。服务器需保持运行，关闭浏览器仍可继续。
        </span>
      </div>
      {editor && (
        <ScheduleForm
          key={editor.id || 'new'}
          schedule={editor}
          remotes={remotes}
          onClose={() => setEditor(null)}
          onDone={async () => {
            setEditor(null);
            notify(editor.id ? '计划已更新，今日用量保留' : '计划已创建');
            await refresh();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`删除计划 ${deleting.name}？`}
          text="将移除这个计划及它的每日额度记录，已传输文件和任务历史会保留。"
          action="删除计划"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`/schedules/${deleting.id}`, { method: 'DELETE', body: {} });
            setDeleting(null);
            notify('计划已删除');
            await refresh();
          }}
        />
      )}
    </>
  );
}

function ScheduleForm({ schedule, remotes, onClose, onDone }) {
  const [transferOptions, setTransferOptions] = useState({
    filters: schedule.filters || emptyTransferOptions.filters,
    selections: schedule.selections || [],
  });
  const [analysis, setAnalysis] = useState(null),
    [acknowledge, setAcknowledge] = useState(false);
  const initialUnit =
    schedule.dailyBytes && schedule.dailyBytes < 1024 ** 3 ? 1024 ** 2 : 1024 ** 3;
  const [values, setValues] = useState({
    name: schedule.name || '',
    startTime: schedule.startTime || '01:00',
    timezone: schedule.timezone || 'Asia/Shanghai',
    mode: schedule.mode || 'copy',
    source: schedule.source || {
      remote:
        remotes.find(
          (item) => !item.pending && ['openlist-115', 'direct-115', '115'].includes(item.type),
        )?.name || 'local',
      path: '',
    },
    destination: schedule.destination || {
      remote:
        remotes.find((item) => !item.pending && ['drive-group', 'drive'].includes(item.type))
          ?.name || 'local',
      path: '',
    },
    scanIntervalMinutes: schedule.scanIntervalMinutes || 0,
    media: { ...defaultMediaOptions, enabled: !schedule.id, ...schedule.media },
    enabled: schedule.enabled ?? true,
    cutoffMode: schedule.cutoffMode || 'hard',
  });
  const [volumeLimited, setVolumeLimited] = useState(
    schedule.id ? Boolean(schedule.dailyBytes) : true,
  );
  const [timeLimited, setTimeLimited] = useState(
    schedule.id ? Boolean(schedule.dailySeconds) : true,
  );
  const [volume, setVolume] = useState(
    schedule.dailyBytes ? schedule.dailyBytes / initialUnit : 100,
  );
  const [unit, setUnit] = useState(initialUnit);
  const [hours, setHours] = useState(schedule.dailySeconds ? schedule.dailySeconds / 3600 : 4);
  const [sourcePathsText, setSourcePathsText] = useState((schedule.sourcePaths || []).join('\n'));
  const sourcePaths = [
    ...new Set(
      sourcePathsText
        .split('\n')
        .map((path) => path.trim())
        .filter(Boolean),
    ),
  ];
  const [preview, setPreview] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [mediaConfirmed, setMediaConfirmed] = useState(false);
  const requiresMediaConfirmation =
    values.media.enabled &&
    (values.media.archive !== 'preserve' ||
      values.media.rename !== 'preserve' ||
      values.media.conflict === 'overwrite');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = (key, value) => setValues((previous) => ({ ...previous, [key]: value }));
  useEffect(() => {
    setAnalysis(null);
    setAcknowledge(false);
  }, [
    values.source.remote,
    values.source.path,
    values.destination.remote,
    values.destination.path,
    volumeLimited,
    volume,
    unit,
    values.cutoffMode,
    sourcePathsText,
    values.media,
    transferOptions,
  ]);
  useEffect(() => {
    setPreview(null);
    setMediaConfirmed(false);
  }, [values.source, values.destination, sourcePathsText, values.media, transferOptions]);
  useEffect(() => {
    if (values.mode === 'sync' || sourcePaths.length)
      setTransferOptions((previous) =>
        previous.selections.length ? { ...previous, selections: [] } : previous,
      );
  }, [values.mode, sourcePathsText]);
  useEffect(() => {
    if ((values.media.enabled || sourcePaths.length) && values.mode !== 'copy')
      change('mode', 'copy');
  }, [values.media.enabled, sourcePathsText, values.mode]);
  const storageOptions = [
    { name: 'local', label: '本地文件目录' },
    ...remotes
      .filter((item) => !item.pending)
      .map((item) => ({
        name: item.name,
        upload: item.capabilities?.upload !== false,
        label: `${item.accountLabel || item.name} · ${providerInfo(item.type).title}`,
      })),
  ];
  function endpoint(key, label) {
    const value = values[key];
    return (
      <div className="endpoint-fields">
        <h3>{label}</h3>
        <label className="field">
          <span>存储</span>
          <select
            aria-label={`${label}存储`}
            value={value.remote}
            onChange={(event) => {
              change(key, { ...value, remote: event.target.value, path: '' });
              if (key === 'source') {
                setSourcePathsText('');
                setTransferOptions((previous) => ({ ...previous, selections: [] }));
              }
              setAnalysis(null);
              setAcknowledge(false);
            }}
          >
            {storageOptions
              .filter((item) => key === 'source' || item.upload !== false)
              .map((item) => (
                <option key={item.name} value={item.name}>
                  {item.label}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>{label}路径（可自定义）</span>
          <input
            aria-label={`${label}路径`}
            value={value.path}
            placeholder={
              key === 'source'
                ? '例如：电影/科幻，留空为根目录'
                : '例如：115备份/科幻，留空为根目录'
            }
            onChange={(event) => {
              change(key, { ...value, path: event.target.value });
              if (key === 'source')
                setTransferOptions((previous) => ({ ...previous, selections: [] }));
              setAnalysis(null);
              setAcknowledge(false);
            }}
          />
          <small>
            {key === 'source'
              ? '填写要读取的文件夹，或点击下方“浏览源目录”选择。'
              : '填写要写入的文件夹，或浏览选择、新建目标目录。'}
            路径相对于所选存储根目录，使用 / 分隔。
          </small>
        </label>
      </div>
    );
  }
  function input() {
    return {
      ...values,
      ...transferOptions,
      sourcePaths,
      scanIntervalMinutes: Number(values.scanIntervalMinutes),
      confirmDelete: confirmed,
      dailyBytes: volumeLimited ? Math.round(Number(volume) * unit) : 0,
      dailySeconds: timeLimited ? Math.round(Number(hours) * 3600) : 0,
    };
  }
  async function previewFiles() {
    setPreviewBusy(true);
    setError('');
    try {
      if (sourcePaths.length > 20) throw new Error('最多设置 20 个来源目录。');
      setPreview(await api('/media/preview', { method: 'POST', body: input() }));
    } catch (error) {
      setError(error.message);
    } finally {
      setPreviewBusy(false);
    }
  }
  async function submit(event) {
    event.preventDefault();
    const startTime = event.currentTarget.elements.namedItem('startTime').value;
    setBusy(true);
    setError('');
    try {
      if (sourcePaths.length > 20) throw new Error('最多设置 20 个来源目录。');
      const interval = Number(values.scanIntervalMinutes);
      if (!Number.isInteger(interval) || (interval !== 0 && (interval < 5 || interval > 1440)))
        throw new Error('检查间隔须为 0，或 5 至 1440 的整数分钟。');
      if (!volumeLimited && !timeLimited && !interval)
        throw new Error('每天运行一次时至少启用一项每日限制；也可开启定期检查。');
      if (requiresMediaConfirmation && (!preview || !mediaConfirmed))
        throw new Error('请先预览目标路径并确认归档、命名与覆盖规则。');
      if ((volumeLimited && !(Number(volume) > 0)) || (timeLimited && !(Number(hours) > 0)))
        throw new Error('启用的容量或时长限制必须大于 0。');
      if (values.cutoffMode === 'hard' && !acknowledge) {
        const inspected = await api('/transfers/analyze', {
          method: 'POST',
          body: input(),
        });
        setAnalysis(inspected);
        if (inspected.warning)
          throw new Error('有文件超过每日容量，请查看文件检查结果，调整停止方式或确认后继续。');
      }
      await api(schedule.id ? `/schedules/${schedule.id}` : '/schedules', {
        method: schedule.id ? 'PUT' : 'POST',
        body: { ...input(), startTime },
      });
      await onDone();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      wide
      title={schedule.id ? '编辑计划任务' : '新建计划任务'}
      subtitle="每天按时开始，支持定期扫描新增影视；源文件始终保留。"
      onClose={busy ? () => {} : onClose}
    >
      <form onSubmit={submit}>
        <fieldset className="modal-body schedule-form-body" disabled={busy || previewBusy}>
          <label className="field">
            <span>计划名称</span>
            <input
              aria-label="计划名称"
              required
              maxLength={80}
              placeholder="例如：每日影音库迁移"
              value={values.name}
              onChange={(event) => change('name', event.target.value)}
            />
          </label>
          <div className="schedule-form-grid">
            <label className="field">
              <span>每天开始时间</span>
              <input
                aria-label="每天开始时间"
                name="startTime"
                type="time"
                required
                value={values.startTime}
                onChange={(event) => change('startTime', event.target.value)}
                onInput={(event) => change('startTime', event.target.value)}
              />
            </label>
            <label className="field">
              <span>时区</span>
              <input
                aria-label="计划时区"
                required
                list="schedule-timezones"
                disabled={Boolean(schedule.lastStartedAt)}
                value={values.timezone}
                onChange={(event) => change('timezone', event.target.value)}
              />
              <datalist id="schedule-timezones">
                {[
                  'Asia/Shanghai',
                  'Asia/Hong_Kong',
                  'UTC',
                  'Asia/Tokyo',
                  'Europe/London',
                  'America/New_York',
                  'America/Los_Angeles',
                ].map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
              <small>
                {schedule.lastStartedAt
                  ? '已执行的计划固定时区，防止重复计算每日额度。'
                  : '每日额度按此时区的午夜重置。'}
              </small>
            </label>
          </div>
          <label className="field">
            <span>新增文件检查间隔（分钟）</span>
            <input
              aria-label="新增文件检查间隔"
              type="number"
              min="0"
              max="1440"
              step="1"
              required
              value={values.scanIntervalMinutes}
              onChange={(event) => change('scanIntervalMinutes', event.target.value)}
            />
            <small>
              0 表示每天运行一次；5 至 1440
              表示本轮结束后定期再次检查。检查与传输共用当天额度，到次日按设定时间继续。
            </small>
          </label>
          <div className="mode-grid">
            <button
              type="button"
              className={`mode-choice ${values.mode === 'copy' ? 'selected' : ''}`}
              onClick={() => {
                change('mode', 'copy');
                setConfirmed(false);
              }}
            >
              <span>
                <Plus size={17} />
                复制<small>推荐</small>
              </span>
              <p>
                {values.media?.enabled || values.sourcePaths?.length
                  ? '复制未传文件；已有文件按所选规则处理。'
                  : '复制新增与更新文件，保留目标其他文件。'}
              </p>
            </button>
            <button
              type="button"
              className={`mode-choice ${values.mode === 'sync' ? 'selected' : ''}`}
              disabled={values.media.enabled || sourcePaths.length > 0}
              onClick={() => {
                change('mode', 'sync');
                setConfirmed(false);
              }}
            >
              <span>
                <ArrowRight size={17} />
                同步
              </span>
              <p>
                {values.media.enabled || sourcePaths.length
                  ? '影视与多个来源计划使用复制，保护目标已有文件。'
                  : '使目标与源目录一致，删除目标多余文件。'}
              </p>
            </button>
          </div>
          <div className="endpoint-grid">
            {endpoint('source', '源目录')}
            <span className="endpoint-arrow">
              <ArrowRight size={22} />
            </span>
            {endpoint('destination', '目标目录')}
          </div>
          <label className="field schedule-multiple-sources">
            <span>多个来源目录（选填，每行一个，最多 20 个）</span>
            <textarea
              aria-label="多个来源目录"
              rows={3}
              value={sourcePathsText}
              placeholder={'电影/科幻\n剧集/美剧'}
              onChange={(event) => setSourcePathsText(event.target.value)}
            />
            <small>
              所有目录来自上方同一个源网盘；留空时使用源目录。填写后传输各目录的完整内容，不能勾选部分文件。每个目录以其最后一层文件夹名称作为目标前缀，避免混合；重复或重叠目录会合并。
            </small>
          </label>
          <MediaOptionsFields
            value={values.media}
            onChange={(media) => change('media', media)}
            disabled={busy}
          />
          <TransferHint remotes={remotes} source={values.source} destination={values.destination} />
          <TransferControls
            source={values.source}
            destination={values.destination}
            setSource={(value) => {
              change('source', value);
              setTransferOptions((previous) => ({ ...previous, selections: [] }));
              setAnalysis(null);
              setAcknowledge(false);
            }}
            setDestination={(value) => {
              change('destination', value);
              setAnalysis(null);
              setAcknowledge(false);
            }}
            value={{ ...transferOptions, media: values.media, sourcePaths }}
            allowSelections={!sourcePaths.length}
            onChange={(value) => {
              setTransferOptions({
                filters: value.filters,
                selections: sourcePaths.length ? [] : value.selections,
              });
              setAnalysis(null);
              setAcknowledge(false);
            }}
            mode={values.mode}
            dailyBytes={volumeLimited ? Math.round(Number(volume) * unit) : 0}
            analysis={analysis}
            onAnalysis={setAnalysis}
            acknowledge={acknowledge}
            setAcknowledge={setAcknowledge}
          />
          {(values.media.enabled || sourcePaths.length > 0) && (
            <section className="schedule-preview">
              <button
                type="button"
                className="button secondary"
                disabled={busy || previewBusy}
                onClick={previewFiles}
              >
                {previewBusy ? <Spinner /> : <RefreshCw size={15} />}预览传输文件与目标路径
              </button>
              <p>
                预览按当前目录、文件筛选与影视规则计算；实际运行时重新检查源文件和目标已传文件。
              </p>
              {preview && (
                <>
                  <strong>
                    {preview.totalFiles ?? preview.files?.length ?? 0} 个文件 ·{' '}
                    {capacity(preview.totalBytes || 0)}
                    {preview.skippedExisting ? ` · 已传 ${preview.skippedExisting} 项` : ''}
                    {preview.conflicts ? ` · 冲突 ${preview.conflicts} 项` : ''}
                  </strong>
                  <div className="schedule-preview-list">
                    {(preview.files || []).slice(0, 50).map((file, index) => (
                      <div key={`${file.sourceFile}-${index}`}>
                        <span title={file.sourceFile}>{file.sourceFile || file.path}</span>
                        <ArrowRight size={13} />
                        <span title={file.targetFile}>{file.targetFile || file.path}</span>
                        <small>
                          {capacity(file.size)}
                          {file.action === 'skip'
                            ? ' · 已传，跳过'
                            : file.action === 'conflict'
                              ? ' · 同名冲突'
                              : file.exists
                                ? ' · 目标已存在'
                                : ' · 待传输'}
                        </small>
                      </div>
                    ))}
                  </div>
                  {preview.totalFiles > 50 && (
                    <small>预览展示前 50 项，计划运行时处理全部符合规则的文件。</small>
                  )}
                </>
              )}
              {requiresMediaConfirmation && (
                <label className="checkbox warning">
                  <input
                    type="checkbox"
                    disabled={!preview}
                    checked={mediaConfirmed}
                    onChange={(event) => setMediaConfirmed(event.target.checked)}
                  />
                  <span>
                    我已预览并确认目标路径、命名整理和同名文件处理规则。仅整理目标，115 源文件保留。
                  </span>
                </label>
              )}
            </section>
          )}
          <div className="schedule-limits">
            <h3>每日限制</h3>
            <p>
              每天运行一次时至少启用一项；开启定期检查后可不设限制。两项同时启用时先达到任意限制就停止。
            </p>
            <label className="toggle-row">
              <div>
                <strong>限制每日传输容量</strong>
                <small>当天多个来源、重复扫描和重试共享同一个额度。</small>
              </div>
              <input
                type="checkbox"
                role="switch"
                aria-label="限制每日传输容量"
                checked={volumeLimited}
                onChange={(event) => setVolumeLimited(event.target.checked)}
              />
            </label>
            {volumeLimited && (
              <div className="schedule-limit-input">
                <label className="field">
                  <span>每日传输容量</span>
                  <input
                    aria-label="每日传输容量"
                    required
                    type="number"
                    min="0.001"
                    step="any"
                    value={volume}
                    onChange={(event) => setVolume(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>单位</span>
                  <select
                    aria-label="容量单位"
                    value={unit}
                    onChange={(event) => {
                      setVolume((Number(volume) * unit) / Number(event.target.value));
                      setUnit(Number(event.target.value));
                    }}
                  >
                    {[
                      [1024 ** 2, 'MiB'],
                      [1024 ** 3, 'GiB'],
                      [1024 ** 4, 'TiB'],
                    ].map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <label className="toggle-row">
              <div>
                <strong>限制每日运行时长</strong>
                <small>累计计算检查目录和传输的运行时间。</small>
              </div>
              <input
                type="checkbox"
                role="switch"
                aria-label="限制每日运行时长"
                checked={timeLimited}
                onChange={(event) => setTimeLimited(event.target.checked)}
              />
            </label>
            {timeLimited && (
              <label className="field">
                <span>每日运行时长（小时）</span>
                <input
                  aria-label="每日运行时长（小时）"
                  required
                  type="number"
                  min="0.001"
                  max="24"
                  step="any"
                  value={hours}
                  onChange={(event) => setHours(event.target.value)}
                />
              </label>
            )}
          </div>
          <label className="field">
            <span>达到限制后</span>
            <select
              aria-label="达到限制后的行为"
              value={values.cutoffMode}
              onChange={(event) => change('cutoffMode', event.target.value)}
            >
              <option value="hard">立即停止</option>
              <option value="soft">完成正在传输的文件后停止</option>
            </select>
            <small>
              {values.cutoffMode === 'soft'
                ? '正在传输的文件会继续完成，容量或时长可能超过设定值。'
                : '正在传输的文件会中断；次日可能需要重新传输该文件。单个文件大于每日额度时，建议选择完成当前文件后停止。'}
            </small>
          </label>
          <label className="toggle-row">
            <div>
              <strong>启用每日调度</strong>
              <small>今天的开始时间已过时，保存后会立即开始。</small>
            </div>
            <input
              type="checkbox"
              role="switch"
              aria-label="启用每日调度"
              checked={values.enabled}
              onChange={(event) => change('enabled', event.target.checked)}
            />
          </label>
          <div className="callout">
            <Clock3 size={16} />
            <span>
              影视增量按单个文件检查目标，匹配时跳过；同名冲突按所选规则处理。源文件保留。跨日会结束本轮任务；未完成的大文件能否续传取决于存储类型。服务需保持运行。
            </span>
          </div>
          {values.mode === 'sync' && (
            <label className="checkbox warning">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>我已确认目标目录，同意每日同步删除目标中源目录没有的文件。</span>
            </label>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </fieldset>
        <footer className="modal-footer">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            className="button primary"
            disabled={
              busy ||
              previewBusy ||
              (!volumeLimited && !timeLimited && !Number(values.scanIntervalMinutes)) ||
              (values.mode === 'sync' && !confirmed) ||
              (requiresMediaConfirmation && (!preview || !mediaConfirmed))
            }
          >
            {busy ? <Spinner /> : <CalendarClock size={16} />}
            {schedule.id ? '保存计划' : '创建计划'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
