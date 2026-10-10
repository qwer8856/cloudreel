import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Clapperboard,
  Cloud,
  FolderOpen,
  Play,
  RefreshCw,
  ShieldCheck,
  Plus,
  Trash2,
} from 'lucide-react';
import { api, bytes, providerInfo } from './api.js';
import { ProviderBadge, Spinner } from './components.jsx';
import { emptyTransferOptions, TransferControls } from './transfer-controls.jsx';
import './media.css';
import { MediaScanProgress, readScanDraft, useMediaScan } from './media-scan.jsx';

export const defaultMediaOptions = {
  enabled: true,
  preset: 'all',
  archive: 'preserve',
  rename: 'preserve',
  movieFolder: '电影',
  seriesFolder: '剧集',
  rules: [],
  conflict: 'skip',
};

export function MediaOptionsFields({ value, onChange, disabled = false }) {
  const options = { ...defaultMediaOptions, ...value };
  const change = (key, next) => onChange({ ...options, enabled: true, [key]: next });
  const updateRule = (index, key, next) =>
    change(
      'rules',
      options.rules.map((rule, at) => (at === index ? { ...rule, [key]: next } : rule)),
    );
  return (
    <fieldset className="media-options" disabled={disabled}>
      <legend>影视文件与归档规则</legend>
      <div className="ops-grid">
        <label className="field">
          <span>传输哪些文件</span>
          <select value={options.preset} onChange={(event) => change('preset', event.target.value)}>
            <option value="all">全部文件，保留影视附属资料</option>
            <option value="videos">仅视频文件</option>
            <option value="bundle">视频、字幕、海报与 NFO</option>
          </select>
        </label>
        <label className="field">
          <span>目标目录整理</span>
          <select
            value={options.archive}
            onChange={(event) => change('archive', event.target.value)}
          >
            <option value="preserve">保留来源目录结构</option>
            <option value="type">按电影 / 剧集分目录</option>
            <option value="rules">按目录和文件名规则归档</option>
          </select>
        </label>
        <label className="field">
          <span>文件命名</span>
          <select value={options.rename} onChange={(event) => change('rename', event.target.value)}>
            <option value="preserve">保留原文件名（推荐）</option>
            <option value="clean">清理发布组与画质标记</option>
          </select>
          <small>整理只作用于目标文件；开始前可查看每个文件的目标名称。</small>
        </label>
        <label className="field">
          <span>目标已有同名文件</span>
          <select
            value={options.conflict}
            onChange={(event) => change('conflict', event.target.value)}
          >
            <option value="skip">跳过，保护已有文件</option>
            <option value="overwrite">允许更新 / 覆盖已有文件</option>
          </select>
          <small>预览会检查目标路径。默认跳过已有文件，大小不同时也会提示。</small>
        </label>
      </div>
      {options.archive === 'type' && (
        <>
          <div className="ops-grid">
            <label className="field">
              <span>电影目标子目录</span>
              <input
                value={options.movieFolder}
                onChange={(event) => change('movieFolder', event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>剧集目标子目录</span>
              <input
                value={options.seriesFolder}
                onChange={(event) => change('seriesFolder', event.target.value)}
                required
              />
            </label>
          </div>
          <p className="muted">
            根据目录名称与 S01E01 等剧集标记分类；请检查预览，未识别的文件按电影归档。
          </p>
        </>
      )}
      {options.archive === 'rules' && (
        <div className="media-rules">
          <p className="muted">
            按顺序匹配来源相对路径；* 匹配文件名，**
            匹配多级目录。首条匹配生效，未匹配时保留原路径。
          </p>
          <p className="muted">
            {
              '目录可使用 {type}、{title}、{year}、{season}、{folder}；例如 电影/{title} ({year})。年份或季数缺失时使用“未知年份”或“未分季”，请核对预览。'
            }
          </p>
          {options.rules.map((rule, index) => (
            <div className="media-rule" key={index}>
              <label className="field">
                <span>匹配规则 {index + 1}</span>
                <input
                  value={rule.pattern}
                  required
                  placeholder="**/S01E*"
                  onChange={(event) => updateRule(index, 'pattern', event.target.value)}
                />
              </label>
              <label className="field">
                <span>归档到目标子目录</span>
                <input
                  value={rule.folder}
                  required
                  placeholder="剧集/第一季"
                  onChange={(event) => updateRule(index, 'folder', event.target.value)}
                />
              </label>
              <button
                className="icon-button"
                type="button"
                aria-label={`删除规则 ${index + 1}`}
                onClick={() =>
                  change(
                    'rules',
                    options.rules.filter((_, at) => at !== index),
                  )
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          <button
            className="button secondary"
            type="button"
            disabled={options.rules.length >= 50}
            onClick={() => change('rules', [...options.rules, { pattern: '', folder: '' }])}
          >
            <Plus size={15} />
            添加归档规则
          </button>
        </div>
      )}
      {options.conflict === 'overwrite' && (
        <p className="ops-warning">你已允许更新目标已有文件。请核对预览中的目标路径。</p>
      )}
    </fieldset>
  );
}

function sourcePathsFromText(text) {
  return [
    ...new Set(
      text
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

export function MediaPage({ remotes, status, notify, refresh, openRemote, onJob, onSchedules }) {
  const [savedScan] = useState(() => readScanDraft('cloudreel.media.scan'));
  const connected = remotes.filter((remote) => !remote.pending);
  const preferredTypes = (type) =>
    type === 'drive'
      ? ['drive-group', 'drive']
      : type === 'openlist-115'
        ? ['cd2-webdav', 'direct-115', 'openlist-115']
        : [type];
  const findPreferred = (type) =>
    preferredTypes(type)
      .map((value) => connected.find((remote) => remote.type === value))
      .find(Boolean)?.name || '';
  const [source, setSource] = useState(
    savedScan?.input?.source || { remote: findPreferred('openlist-115'), path: '' },
  );
  const [destination, setDestination] = useState(
    savedScan?.input?.destination || { remote: findPreferred('drive'), path: '' },
  );
  const [name, setName] = useState(savedScan?.input?.name || '');
  const [options, setOptions] = useState({
    ...emptyTransferOptions,
    sourcePaths: [],
    filters: savedScan?.input?.filters || emptyTransferOptions.filters,
    selections: savedScan?.input?.selections || [],
    media: { ...defaultMediaOptions, ...savedScan?.input?.media },
  });
  const [extraPaths, setExtraPaths] = useState(
    (savedScan?.input?.sourcePaths || [])
      .filter((p) => p !== savedScan?.input?.source?.path)
      .join('\n'),
  );
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const previewKey = JSON.stringify([source, destination, options, extraPaths]);
  const lastPreviewKey = useRef(previewKey);
  const scanTask = useMediaScan({
    storageKey: 'cloudreel.media.scan',
    initialId: savedScan?.id,
    onResult: (result) => {
      setPreview(result);
      setConfirmed(false);
      setError('');
    },
    onError: setError,
  });
  const previewBusy = scanTask.running;
  const paths = sourcePathsFromText(extraPaths);
  const multiple = paths.length > 0;
  useEffect(() => {
    if (!source.remote)
      setSource((current) => ({ ...current, remote: findPreferred('openlist-115') }));
    if (!destination.remote)
      setDestination((current) => ({ ...current, remote: findPreferred('drive') }));
  }, [remotes]);
  useEffect(() => {
    if (lastPreviewKey.current === previewKey) return;
    lastPreviewKey.current = previewKey;
    setPreview(null);
    setConfirmed(false);
    scanTask.reset();
  }, [source, destination, options, extraPaths]);
  const payload = () => ({
    name,
    mode: 'copy',
    source,
    destination,
    ...options,
    sourcePaths: multiple ? [...new Set([source.path.trim(), ...paths])] : [],
    selections: multiple ? [] : options.selections,
    media: { ...options.media, enabled: true },
  });
  const requiresConfirmation =
    options.media.rename !== 'preserve' ||
    options.media.archive !== 'preserve' ||
    options.media.conflict === 'overwrite';
  const canTransfer =
    status?.available &&
    connected.some((remote) => remote.name === source.remote) &&
    connected.some((remote) => remote.name === destination.remote) &&
    paths.length < 20;
  async function scan() {
    if (previewBusy || !canTransfer) return;
    setError('');
    setPreview(null);
    try {
      await scanTask.start(payload());
    } catch (error) {
      setError(error.message);
    }
  }
  async function submit(event) {
    event.preventDefault();
    if (busy || !preview || (requiresConfirmation && !confirmed)) return;
    setBusy(true);
    setError('');
    try {
      const job = await api('/jobs', {
        method: 'POST',
        body: { ...payload(), scanId: preview.scanId },
      });
      notify('影视传输已加入队列');
      await refresh();
      onJob?.(job.id);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  const sourceRemote = connected.find((remote) => remote.name === source.remote);
  const targetRemote = connected.find((remote) => remote.name === destination.remote);
  function endpoint(value, setter, label, side) {
    const remote = side === 'source' ? sourceRemote : targetRemote;
    return (
      <section className="media-endpoint">
        <div className="media-endpoint-heading">
          <ProviderBadge type={remote?.type || (side === 'source' ? 'openlist-115' : 'drive')} />
          <div>
            <small>{side === 'source' ? '从这里读取' : '传到这里'}</small>
            <h3>{label}</h3>
          </div>
          <button
            type="button"
            className="text-button"
            onClick={() => openRemote(null, side === 'source' ? 'openlist-115' : 'drive')}
          >
            连接网盘
          </button>
        </div>
        <label className="field">
          <span>{label}账号</span>
          <select
            required
            aria-label={`${label}账号`}
            value={value.remote}
            onChange={(event) => {
              setter({ remote: event.target.value, path: '' });
              if (side === 'source') {
                setExtraPaths('');
                setOptions((current) => ({ ...current, selections: [], sourcePaths: [] }));
              }
            }}
          >
            <option value="">请选择已连接的网盘</option>
            {[...connected]
              .filter((remote) => side === 'source' || remote.capabilities?.upload !== false)
              .sort(
                (a, b) =>
                  (preferredTypes(side === 'source' ? 'openlist-115' : 'drive').indexOf(a.type) < 0
                    ? 100
                    : preferredTypes(side === 'source' ? 'openlist-115' : 'drive').indexOf(
                        a.type,
                      )) -
                  (preferredTypes(side === 'source' ? 'openlist-115' : 'drive').indexOf(b.type) < 0
                    ? 100
                    : preferredTypes(side === 'source' ? 'openlist-115' : 'drive').indexOf(b.type)),
              )
              .map((remote) => (
                <option key={remote.name} value={remote.name}>
                  {remote.accountLabel || remote.name} · {providerInfo(remote.type).title}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>{label}目录</span>
          <input
            aria-label={`${label}目录`}
            placeholder={
              side === 'source' ? '例如：影视/电影，留空为根目录' : '例如：影视库，留空为根目录'
            }
            value={value.path}
            onChange={(event) => {
              setter({ ...value, path: event.target.value });
              if (side === 'source') setOptions((current) => ({ ...current, selections: [] }));
            }}
          />
          <small>相对于网盘根目录；也可以使用下方的浏览按钮选择。</small>
        </label>
      </section>
    );
  }
  return (
    <>
      <div className="page-title">
        <div>
          <h1>影视传输</h1>
          <p>把 115 的电影和剧集，持续传到 Google Drive。</p>
        </div>
        <button type="button" className="button secondary" onClick={onSchedules}>
          <CalendarClock size={16} />
          定时定量传输
        </button>
      </div>
      <section className="media-intro">
        <span className="media-intro-icon">
          <Clapperboard size={27} />
        </span>
        <div>
          <strong>
            115 网盘{' '}
            {sourceRemote?.type === 'cd2-webdav' && (
              <>
                <ArrowRight size={17} /> CD2 WebDAV
              </>
            )}{' '}
            <ArrowRight size={17} />{' '}
            {targetRemote?.type === 'drive-group' ? 'Google Drive group' : 'Google Drive'}
          </strong>
          <p>选择目录 · 检查已传文件 · 后台复制 · 失败重试</p>
        </div>
        <span className="media-protection">
          <ShieldCheck size={15} />
          保留 115 原文件
        </span>
      </section>
      {(!connected.some((remote) =>
        ['cd2-webdav', 'direct-115', 'openlist-115'].includes(remote.type),
      ) ||
        !connected.some((remote) => ['drive-group', 'drive'].includes(remote.type))) && (
        <section className="panel ops-panel media-connect">
          <h3>先连接你的两个网盘</h3>
          <p className="muted">
            115 连接用于读取影视文件，Google Drive 连接用于保存。连接完成后即可浏览目录。
          </p>
          <div className="ops-toolbar">
            <button
              type="button"
              className="button secondary"
              disabled={!status?.available}
              onClick={() => openRemote(null, 'cd2-webdav')}
            >
              <FolderOpen size={16} />
              连接 CD2 WebDAV
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!status?.available}
              onClick={() => openRemote(null, 'openlist-115')}
            >
              <FolderOpen size={16} />
              连接 115 网盘
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!status?.available}
              onClick={() => openRemote(null, 'drive')}
            >
              <Cloud size={16} />
              连接 Google Drive
            </button>
          </div>
        </section>
      )}
      <form className="panel ops-panel media-transfer" onSubmit={submit}>
        <fieldset className="media-form-fieldset" disabled={busy || previewBusy}>
          <div className="media-section-heading">
            <span>1</span>
            <div>
              <h3>选择来源和目标</h3>
              <p>手动填写路径，或浏览网盘并勾选需要传输的文件。</p>
            </div>
          </div>
          <label className="field">
            <span>任务名称（可选）</span>
            <input
              value={name}
              maxLength={80}
              placeholder="例如：电影库迁移"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="media-endpoints">
            {endpoint(source, setSource, '115 来源', 'source')}
            {endpoint(destination, setDestination, '谷歌目标', 'destination')}
          </div>
          <details className="media-multiple">
            <summary>增加多个来源目录</summary>
            <label className="field">
              <span>其他来源目录，每行一个</span>
              <textarea
                aria-label="其他来源目录"
                rows={3}
                placeholder={'影视/剧集\n影视/纪录片'}
                value={extraPaths}
                onChange={(event) => {
                  setExtraPaths(event.target.value);
                  setOptions((current) => ({ ...current, selections: [], sourcePaths: [] }));
                }}
              />
              <small>
                同一来源账号最多 20
                个目录（含上方来源）。多目录时按整目录扫描，不使用文件勾选；每个来源文件夹保留独立目录。
              </small>
            </label>
            {paths.length >= 20 && <p className="form-error">最多添加 19 个其他目录。</p>}
          </details>
          <TransferControls
            source={source}
            destination={destination}
            setSource={(next) => {
              setSource(next);
              setOptions((current) => ({ ...current, selections: [] }));
            }}
            setDestination={setDestination}
            value={options}
            onChange={setOptions}
            showAnalysis={false}
            allowSelections={!multiple}
          />
          <div className="media-section-heading">
            <span>2</span>
            <div>
              <h3>选择影视与归档规则</h3>
              <p>默认保留目录和文件名，跳过目标已有文件。</p>
            </div>
          </div>
          <MediaOptionsFields
            value={options.media}
            onChange={(media) => setOptions((current) => ({ ...current, media }))}
          />
          <div className="media-section-heading">
            <span>3</span>
            <div>
              <h3>后台扫描后确认传输</h3>
              <p>按目录分批扫描，可查看进度和取消；完成后核对文件清单并确认传输。</p>
            </div>
          </div>
          <button
            type="button"
            className="button secondary"
            disabled={!canTransfer || previewBusy || busy}
            onClick={scan}
          >
            {previewBusy ? <Spinner /> : <RefreshCw size={16} />}
            {previewBusy ? '正在后台扫描…' : '扫描与预览'}
          </button>
        </fieldset>
        <MediaScanProgress task={scanTask} />
        {preview && (
          <section className="media-preview" aria-live="polite">
            <div className="media-preview-summary">
              <CheckCircle2 size={18} />
              <strong>
                {preview.totalFiles ?? preview.files?.length ?? 0} 个文件 ·{' '}
                {bytes(preview.totalBytes)}
              </strong>
              <span>{preview.skippedExisting ?? 0} 个目标已存在</span>
            </div>
            <p className="muted">
              目标路径相对于所选目标目录。
              {multiple ? '多来源目录会保留各自文件夹名称。' : '保留所选目录内的相对路径。'}
              {preview.skippedByFilter > 0 && ` 已筛除 ${preview.skippedByFilter} 个文件。`}
            </p>
            <div className="media-preview-scroll">
              <table>
                <thead>
                  <tr>
                    <th>来源文件</th>
                    <th>目标文件</th>
                    <th>大小</th>
                    <th>目标检查</th>
                  </tr>
                </thead>
                <tbody>
                  {(preview.files || []).slice(0, 200).map((file, index) => (
                    <tr key={`${file.path}-${index}`}>
                      <td>{file.path || file.sourceFile}</td>
                      <td>{file.targetFile}</td>
                      <td>{bytes(file.size)}</td>
                      <td>
                        {file.action === 'conflict'
                          ? '路径冲突'
                          : file.exists
                            ? `${file.sameSize === false ? '已有，大小不同' : '已存在'} · ${file.action === 'skip' ? '跳过' : '允许更新'}`
                            : file.exists === false
                              ? '待传输'
                              : '未检查'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!preview.files?.length && <p className="muted">没有找到符合条件的文件。</p>}
            {(preview.truncated || preview.totalFiles > 200 || preview.files?.length > 200) && (
              <p className="muted">这里只展示前 200 个文件，传输会处理全部符合规则的文件。</p>
            )}
            {preview.conflicts > 0 && (
              <p className="ops-warning">
                发现 {preview.conflicts} 个目标同名差异或目录。
                {options.media.conflict === 'skip'
                  ? '这些文件会跳过，保护目标已有内容，其余文件可继续传输。'
                  : '已有文件按允许覆盖的规则更新；同名目录会跳过。'}
              </p>
            )}
            {requiresConfirmation && (
              <label className="media-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>我已核对目标目录、整理后的文件名和已有文件处理方式。</span>
              </label>
            )}
          </section>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="media-submit">
          <button
            className="button primary"
            disabled={
              !canTransfer ||
              busy ||
              previewBusy ||
              !preview ||
              !preview.totalFiles ||
              (requiresConfirmation && !confirmed)
            }
          >
            {busy ? <Spinner /> : <Play size={16} />}
            {busy ? '正在创建任务…' : '开始传输'}
          </button>
          <p>任务开始后可关闭页面，在“传输任务”查看进度、暂停和重试。</p>
        </div>
      </form>
      <section className="media-bottom-grid">
        <button className="panel media-shortcut" onClick={onSchedules}>
          <CalendarClock size={23} />
          <div>
            <strong>让传输按计划进行</strong>
            <p>设置每天传多少、什么时候运行，持续检查多个来源目录。</p>
          </div>
          <ArrowRight size={17} />
        </button>
        <button className="panel media-shortcut" onClick={() => onJob?.()}>
          <Clapperboard size={23} />
          <div>
            <strong>查看传输文件与进度</strong>
            <p>查看当前文件、失败原因，恢复任务或只重试失败文件。</p>
          </div>
          <ArrowRight size={17} />
        </button>
      </section>
    </>
  );
}
