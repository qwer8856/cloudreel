import React, { useCallback, useEffect, useRef, useState } from 'react';
import { version as appVersion } from '../package.json';
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  BookOpen,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Cloud,
  Copy,
  ExternalLink,
  File,
  Folder,
  FolderOpen,
  HardDrive,
  LayoutDashboard,
  LogOut,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import { api, bytes, providerInfo, time } from './api.js';
import { SchedulesPage } from './schedules.jsx';
import { MediaPage } from './media.jsx';
import { OpenListSetup } from './cloud.jsx';
import { AccountsPage, QueuePage, ManagementPage } from './operations.jsx';
import {
  Badge,
  ConfirmDialog,
  Dialog,
  Empty,
  JobForm,
  JobTable,
  Logo,
  ProviderBadge,
  RemoteForm,
  Spinner,
} from './components.jsx';

const pages = [
  {
    id: 'media',
    label: '影视传输',
    icon: ArrowRight,
    description: '从 115 网盘到 Google Drive，稳定传输你的影视库。',
  },
  {
    id: 'overview',
    label: '工作台',
    icon: LayoutDashboard,
    description: '掌握存储与传输的每一个状态。',
  },
  {
    id: 'remotes',
    label: '存储连接',
    icon: HardDrive,
    description: '把散落各处的存储，连接在一起。',
  },
  { id: 'files', label: '文件浏览', icon: FolderOpen, description: '浏览云端和本地的文件目录。' },
  {
    id: 'jobs',
    label: '传输任务',
    icon: ArrowLeftRight,
    description: '从一次复制，到有序的同步。',
  },
  {
    id: 'schedules',
    label: '计划任务',
    icon: CalendarClock,
    description: '每天按额度传输，次日自动继续。',
  },
  {
    id: 'settings',
    label: '运行设置',
    icon: SlidersHorizontal,
    description: '让每一次传输更符合你的需要。',
  },
  {
    id: 'accounts',
    label: '账号与额度',
    icon: Users,
    description: '多个账号独立连接，按组共享每日额度。',
  },
  {
    id: 'management',
    label: '通知与备份',
    icon: ShieldCheck,
    description: '任务队列、运行通知与加密恢复。',
  },
];

function StorageVisual() {
  return (
    <div className="storage-visual" aria-hidden="true">
      <svg viewBox="0 0 360 210">
        <path
          d="M76 50H157Q180 50 180 76V109M287 48H205Q180 48 180 75M76 164H154Q180 164 180 137M283 166H206Q180 166 180 139"
          fill="none"
          stroke="#96c7b8"
          strokeWidth="1.5"
          strokeDasharray="5 5"
        />
        <circle cx="180" cy="111" r="67" fill="none" stroke="#d2e8df" />
        <circle cx="180" cy="111" r="89" fill="none" stroke="#dfede7" />
      </svg>
      <div className="visual-core">
        <ArrowLeftRight size={32} />
      </div>
      <div className="visual-node node-a">
        <span className="visual-cloud">
          <Cloud size={20} />
        </span>
        <span>Cloud</span>
      </div>
      <div className="visual-node node-b">
        <span className="visual-s3">S3</span>
        <span>Object storage</span>
      </div>
      <div className="visual-node node-c">
        <span className="visual-folder">
          <Folder size={20} />
        </span>
        <span>Local</span>
      </div>
      <div className="visual-node node-d">
        <span className="visual-webdav">W</span>
        <span>WebDAV</span>
      </div>
    </div>
  );
}

function Metric({ icon: Icon, title, value, detail, color = 'green' }) {
  return (
    <div className="metric-card">
      <div className="metric-top">
        <span>{title}</span>
        <span className={`metric-icon ${color}`}>
          <Icon size={18} />
        </span>
      </div>
      <strong>{value}</strong>
      <p>{detail}</p>
    </div>
  );
}

function TransferChart({ history, status }) {
  const width = 580,
    height = 130;
  const peak = Math.max(...history.map((point) => point.speed), 1024);
  const x = (index) => width - ((history.length - 1 - index) * width) / 29;
  const points = history.map(
    (point, index) => `${x(index)},${height - (point.speed / peak) * (height - 15)}`,
  );
  const path = points.length ? `M${points.join(' L')}` : `M0,${height} L${width},${height}`;
  return (
    <section className="panel chart-panel">
      <div className="panel-heading">
        <div>
          <h3>传输速率</h3>
          <p>最近 2 分钟的实时采样</p>
        </div>
        <span className="chart-legend">
          <i />
          {bytes(status?.stats?.speed)}/s
        </span>
      </div>
      <div className="chart">
        <div className="chart-labels">
          <span>{bytes(peak)}/s</span>
          <span>{bytes(peak / 2)}/s</span>
          <span>0 B/s</span>
        </div>
        <div className="chart-canvas">
          <svg
            viewBox={`0 0 ${width} ${height + 5}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="实时传输速率曲线"
          >
            <defs>
              <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#15937c" stopOpacity=".2" />
                <stop offset="100%" stopColor="#15937c" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0, 0.5, 1].map((ratio) => (
              <line
                key={ratio}
                x1="0"
                x2={width}
                y1={height * ratio}
                y2={height * ratio}
                stroke="#e9edeb"
                strokeDasharray="4 5"
              />
            ))}
            <path
              d={`${path} L${history.length ? ((history.length - 1) / Math.max(29, history.length - 1)) * width : width},${height} L${history.length ? x(0) : 0},${height} Z`}
              fill="url(#chart-fill)"
            />
            <path d={path} fill="none" stroke="#14927c" strokeWidth="2.3" strokeLinejoin="round" />
          </svg>
          {!history.some((point) => point.speed > 0) && (
            <div className="chart-idle">
              <Activity size={16} />
              <span>等待传输数据</span>
            </div>
          )}
          <div className="chart-times">
            <span>2 分钟前</span>
            <span>1 分钟前</span>
            <span>现在</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function Dashboard({ remotes, jobs, status, history, navigate, openRemote, openJob }) {
  const active = jobs.filter((job) => job.status === 'running');
  const completed = jobs.filter((job) => job.status === 'completed');
  return (
    <>
      <section className="hero">
        <div className="hero-text">
          <div className="eyebrow">
            <span />
            ONE WORKSPACE. EVERY STORAGE.
          </div>
          <h1>
            连接每一处存储<span>让文件自由流动。</span>
          </h1>
          <p>
            配置云端与本地存储，在一个清晰的工作台中
            <br className="desktop-break" />
            完成文件管理、备份与同步。
          </p>
          <div className="hero-actions">
            <button
              className="button primary"
              disabled={!status?.available}
              onClick={() => openRemote()}
            >
              <Plus size={16} />
              连接存储
            </button>
            <button className="hero-link" onClick={() => navigate('files')}>
              浏览本地文件
              <ArrowRight size={15} />
            </button>
          </div>
        </div>
        <StorageVisual />
      </section>
      <div className="metric-grid">
        <Metric
          title="存储连接"
          value={remotes.length.toString().padStart(2, '0')}
          icon={HardDrive}
          detail={
            remotes.length
              ? `${remotes.filter((item) => !item.pending).length} 个已配置 · ${remotes.filter((item) => item.pending).length} 个待授权`
              : '连接你的第一个云端存储'
          }
        />
        <Metric
          title="运行中的任务"
          value={active.length.toString().padStart(2, '0')}
          icon={ArrowLeftRight}
          color="blue"
          detail={active.length ? '任务正在后台执行' : '当前没有进行中的传输'}
        />
        <Metric
          title="本次运行已传输"
          value={bytes(status?.stats?.bytes)}
          icon={ArrowDownToLine}
          color="purple"
          detail={`${status?.stats?.transfers || 0} 个文件已完成传输`}
        />
        <Metric
          title="已完成任务"
          value={completed.length.toString().padStart(2, '0')}
          icon={CheckCircle2}
          color="orange"
          detail={jobs.length ? `共 ${jobs.length} 个任务记录（含预演）` : '准备开始第一次文件传输'}
        />
      </div>
      <div className="overview-grid">
        <TransferChart history={history} status={status} />
        <section className="panel quick-start">
          <div className="panel-heading">
            <div>
              <h3>准备就绪，开始连接</h3>
              <p>三步建立你的存储工作流</p>
            </div>
            <span className="subtle-icon">
              <Cloud size={19} />
            </span>
          </div>
          <button onClick={() => openRemote()} disabled={!status?.available}>
            <span className={`step-number ${remotes.length ? 'complete' : ''}`}>
              {remotes.length ? <Check size={14} /> : '1'}
            </span>
            <span>
              <strong>连接存储</strong>
              <small>配置云盘、对象存储或服务器</small>
            </span>
            <ChevronRight size={16} />
          </button>
          <button onClick={() => navigate('files')}>
            <span className="step-number">2</span>
            <span>
              <strong>查看你的文件</strong>
              <small>确认目录与连接正常</small>
            </span>
            <ChevronRight size={16} />
          </button>
          <button onClick={() => openJob()} disabled={!status?.available}>
            <span className={`step-number ${jobs.length ? 'complete' : ''}`}>
              {jobs.length ? <Check size={14} /> : '3'}
            </span>
            <span>
              <strong>创建传输任务</strong>
              <small>复制文件，或预演一次同步</small>
            </span>
            <ChevronRight size={16} />
          </button>
        </section>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h3>
              我的存储<span className="count-pill">{remotes.length}</span>
            </h3>
            <p>所有存储连接，集中管理</p>
          </div>
          <button className="text-button" onClick={() => navigate('remotes')}>
            管理存储
            <ArrowRight size={14} />
          </button>
        </div>
        {remotes.length ? (
          <div className="dashboard-remotes">
            {remotes.slice(0, 4).map((remote) => (
              <button
                key={remote.name}
                className="mini-remote"
                onClick={() => navigate('files', { remote: remote.name, path: '' })}
              >
                <ProviderBadge type={remote.type} />
                <div>
                  <strong>{remote.name}</strong>
                  <small>{providerInfo(remote.type).title}</small>
                </div>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
        ) : (
          <div className="connect-strip">
            <div className="stacked-providers">
              {['webdav', 's3', 'sftp'].map((type) => (
                <ProviderBadge key={type} type={type} />
              ))}
            </div>
            <div>
              <strong>从熟悉的存储开始</strong>
              <p>WebDAV、S3、SFTP，还有更多 rclone 支持的连接。</p>
            </div>
            <button
              className="button secondary"
              disabled={!status?.available}
              onClick={() => openRemote()}
            >
              <Plus size={15} />
              添加存储
            </button>
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h3>最近任务</h3>
            <p>跟踪每一次文件流动</p>
          </div>
          <button className="text-button" onClick={() => navigate('jobs')}>
            全部任务
            <ArrowRight size={14} />
          </button>
        </div>
        <JobTable jobs={jobs.slice(0, 4)} compact onStop={(job) => navigate('jobs')} />
      </section>
    </>
  );
}

function RemotePage({ remotes, status, openRemote, openDelete, browse, notify }) {
  const [search, setSearch] = useState(''),
    [testing, setTesting] = useState(''),
    [results, setResults] = useState({});
  const list = remotes.filter((remote) =>
    `${remote.name} ${providerInfo(remote.type).title} ${remote.type} ${remote.description}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  async function test(remote) {
    setTesting(remote.name);
    try {
      const result = await api(`/remotes/${encodeURIComponent(remote.name)}/test`, {
        method: 'POST',
        body: {},
      });
      setResults((previous) => ({ ...previous, [remote.name]: `连接成功 · ${result.latency} ms` }));
      notify(`${remote.name} 连接成功`);
    } catch (error) {
      setResults((previous) => ({ ...previous, [remote.name]: error.message }));
      notify(error.message, 'error');
    } finally {
      setTesting('');
    }
  }
  return (
    <>
      <div className="page-title">
        <div>
          <h1>
            存储连接<span className="count-pill">{remotes.length}</span>
          </h1>
          <p>把散落各处的存储，连接在一起。</p>
        </div>
        <button
          className="button primary"
          disabled={!status?.available}
          onClick={() => openRemote()}
        >
          <Plus size={17} />
          新建存储
        </button>
      </div>
      <div className="toolbar">
        <div className="search-box">
          <Search size={17} />
          <input
            aria-label="搜索存储"
            placeholder="搜索存储名称、类型或备注…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <span className="muted">{list.length} 个存储连接</span>
      </div>
      {list.length ? (
        <div className="remote-grid">
          {list.map((remote) => (
            <section className="remote-card" key={remote.name}>
              <div className="remote-top">
                <ProviderBadge type={remote.type} />
                <span className={`storage-state ${remote.pending ? 'pending' : ''}`}>
                  <i />
                  {remote.pending
                    ? remote.phase === 'error'
                      ? '需检查登录'
                      : '待完成授权'
                    : '已配置'}
                </span>
              </div>
              <h3>{remote.name}</h3>
              <span className="remote-type">{providerInfo(remote.type).title}</span>
              <p>{remote.description || '还没有添加备注'}</p>
              {results[remote.name] && (
                <div className="connection-result">{results[remote.name]}</div>
              )}
              <div className="remote-actions">
                <button className="text-button" onClick={() => browse(remote.name)}>
                  <FolderOpen size={15} />
                  浏览
                </button>
                <button
                  className="text-button"
                  disabled={!!testing || !status?.available}
                  onClick={() => test(remote)}
                >
                  {testing === remote.name ? <Spinner /> : <Wifi size={15} />}测试
                </button>
                <button
                  className="icon-button"
                  title="编辑配置"
                  aria-label={`编辑 ${remote.name}`}
                  onClick={() => openRemote(remote)}
                >
                  <Settings2 size={16} />
                </button>
                <button
                  className="icon-button danger"
                  title="删除配置"
                  aria-label={`删除 ${remote.name}`}
                  onClick={() => openDelete(remote)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </section>
          ))}
          <button className="remote-add" disabled={!status?.available} onClick={() => openRemote()}>
            <span>
              <Plus size={24} />
            </span>
            <strong>连接另一个存储</strong>
            <small>让你的文件拥有更多可能</small>
          </button>
        </div>
      ) : (
        <section className="panel">
          <Empty
            title={search ? '没有匹配的存储' : '给你的存储一个共同的家'}
            text={
              search ? '试试其他名称或存储类型。' : '用可视化表单连接你的云盘、服务器或对象存储。'
            }
            action={
              !search && (
                <button
                  className="button primary"
                  disabled={!status?.available}
                  onClick={() => openRemote()}
                >
                  <Plus size={16} />
                  连接第一个存储
                </button>
              )
            }
          />
          <div className="popular-row">
            {['openlist-115', 'cd2-webdav', 'drive', 'drive-group', 'webdav'].map((type) => (
              <button
                key={type}
                disabled={!status?.available}
                onClick={() => openRemote(null, type)}
              >
                <ProviderBadge small type={type} />
                {providerInfo(type).title}
              </button>
            ))}
          </div>
        </section>
      )}
      <div className="page-note">
        <ShieldCheck size={15} />
        修改配置前会自动备份，最近 10 份备份保存在面板数据目录中。
      </div>
    </>
  );
}

function FilesPage({ remotes, location, setLocation, status, openJob, notify }) {
  const [items, setItems] = useState([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [search, setSearch] = useState('');
  const [pathInput, setPathInput] = useState(location.path),
    [sort, setSort] = useState('Name');
  const [folderModal, setFolderModal] = useState(false),
    [folderName, setFolderName] = useState(''),
    [busy, setBusy] = useState(false),
    [folderError, setFolderError] = useState('');
  const [truncated, setTruncated] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const result = await api(
        `/files?remote=${encodeURIComponent(location.remote)}&path=${encodeURIComponent(location.path)}`,
      );
      if (current === generation.current) {
        setItems(result.items);
        setTruncated(result.truncated);
      }
    } catch (error) {
      if (current === generation.current) {
        setError(error.message);
        setItems([]);
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [location.remote, location.path]);
  useEffect(() => {
    setPathInput(location.path);
    setSearch('');
    load();
    return () => {
      generation.current++;
    };
  }, [load]);
  const list = items
    .filter((item) => item.Name.toLowerCase().includes(search.toLowerCase()))
    .sort(
      (a, b) =>
        Number(b.IsDir) - Number(a.IsDir) ||
        (sort === 'Size'
          ? b.Size - a.Size
          : sort === 'ModTime'
            ? new Date(b.ModTime) - new Date(a.ModTime)
            : a.Name.localeCompare(b.Name, 'zh-CN')),
    );
  const parts = location.path.split('/').filter(Boolean);
  const readOnly =
    remotes.find((remote) => remote.name === location.remote)?.capabilities?.upload === false;
  async function makeFolder(event) {
    event.preventDefault();
    setBusy(true);
    setFolderError('');
    try {
      if (/[\\/:]|^\.{1,2}$/.test(folderName.trim()))
        throw new Error('文件夹名称不能包含路径分隔符、冒号、. 或 ..。');
      await api('/files/mkdir', {
        method: 'POST',
        body: { remote: location.remote, path: [...parts, folderName.trim()].join('/') },
      });
      setFolderModal(false);
      notify('文件夹已创建');
      await load();
    } catch (error) {
      setFolderError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-title">
        <div>
          <h1>文件浏览</h1>
          <p>从云端到本地，每一个目录都触手可及。</p>
        </div>
        <button
          className="button primary"
          disabled={!status?.available || loading || !!error}
          onClick={() => openJob(location)}
        >
          <Copy size={16} />
          传输此目录
        </button>
      </div>
      <section className="panel file-panel">
        <div className="file-location">
          <label className="storage-select">
            <HardDrive size={17} />
            <select
              aria-label="选择文件存储"
              value={location.remote}
              onChange={(event) => setLocation({ remote: event.target.value, path: '' })}
            >
              <option value="local">本地文件目录</option>
              {remotes.map((remote) => (
                <option key={remote.name} value={remote.name}>
                  {remote.name} · {providerInfo(remote.type).title}
                </option>
              ))}
            </select>
          </label>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setLocation({ ...location, path: pathInput.replace(/^\/+|\/+$/g, '') });
            }}
          >
            <input
              aria-label="目录路径"
              placeholder="输入目录路径，按 Enter 前往"
              value={pathInput}
              onChange={(event) => setPathInput(event.target.value)}
            />
            <button className="icon-button" aria-label="前往目录">
              <ArrowRight size={17} />
            </button>
          </form>
        </div>
        <div className="file-toolbar">
          <div className="breadcrumbs">
            <button
              className="icon-button"
              aria-label="返回上级目录"
              disabled={!parts.length}
              onClick={() => setLocation({ ...location, path: parts.slice(0, -1).join('/') })}
            >
              <ArrowLeft size={17} />
            </button>
            <button onClick={() => setLocation({ ...location, path: '' })}>
              <FolderOpen size={15} />
              根目录
            </button>
            {parts.map((part, index) => (
              <React.Fragment key={index}>
                <ChevronRight size={13} />
                <button
                  onClick={() =>
                    setLocation({ ...location, path: parts.slice(0, index + 1).join('/') })
                  }
                >
                  {part}
                </button>
              </React.Fragment>
            ))}
          </div>
          <div className="file-tools">
            <button
              className="button small-button secondary"
              disabled={!status?.available || !!error || readOnly}
              title={readOnly ? '此连接仅支持读取' : undefined}
              onClick={() => {
                setFolderName('');
                setFolderError('');
                setFolderModal(true);
              }}
            >
              <Plus size={15} />
              新建文件夹
            </button>
            <button className="icon-button" aria-label="刷新文件" disabled={loading} onClick={load}>
              <RefreshCw size={17} className={loading ? 'spin' : ''} />
            </button>
          </div>
        </div>
        <div className="file-search">
          <div className="search-box">
            <Search size={16} />
            <input
              aria-label="搜索当前目录"
              placeholder="搜索当前目录…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <select
            aria-label="文件排序"
            value={sort}
            onChange={(event) => setSort(event.target.value)}
          >
            <option value="Name">按名称排序</option>
            <option value="Size">按大小排序</option>
            <option value="ModTime">按更新时间排序</option>
          </select>
        </div>
        {loading ? (
          <div className="loading-state">
            <Spinner />
            正在读取目录…
          </div>
        ) : error ? (
          <Empty
            icon={CircleHelp}
            title="暂时无法读取目录"
            text={error}
            action={
              <button className="button secondary" onClick={load}>
                <RefreshCw size={15} />
                重试
              </button>
            }
          />
        ) : list.length ? (
          <div className="table-scroll">
            <table className="file-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>大小</th>
                  <th>修改时间</th>
                  <th>类型</th>
                </tr>
              </thead>
              <tbody>
                {list.map((item) => (
                  <tr key={item.Path} className={item.IsDir ? 'directory-row' : ''}>
                    <td>
                      {item.IsDir ? (
                        <button
                          className="file-name"
                          onClick={() =>
                            setLocation({ ...location, path: [...parts, item.Name].join('/') })
                          }
                        >
                          <span className="file-icon folder">
                            <Folder size={19} />
                          </span>
                          {item.Name}
                          <ChevronRight size={14} />
                        </button>
                      ) : (
                        <span className="file-name">
                          <span className="file-icon">
                            <File size={18} />
                          </span>
                          {item.Name}
                        </span>
                      )}
                    </td>
                    <td className="muted">{item.IsDir ? '—' : bytes(item.Size)}</td>
                    <td className="muted nowrap">{time(item.ModTime)}</td>
                    <td className="muted">{item.IsDir ? '文件夹' : item.MimeType || '文件'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon={FolderOpen}
            title={search ? '没有匹配的文件' : '这个目录还是空的'}
            text={
              search ? '试试其他文件名。' : '可以新建文件夹，或创建一个传输任务把文件复制到这里。'
            }
          />
        )}
        <footer className="file-footer">
          <span>
            {list.length} 个项目{truncated ? ' · 仅显示前 10,000 项' : ''}
          </span>
          <span>
            {bytes(items.filter((item) => !item.IsDir).reduce((sum, item) => sum + item.Size, 0))} ·
            当前目录文件总大小
          </span>
        </footer>
      </section>
      {location.remote === 'local' && (
        <div className="page-note">
          <FolderOpen size={15} />
          本地文件目录：<code>{status?.localRoot || 'LOCAL_ROOT'}</code>
        </div>
      )}
      {folderModal && (
        <Dialog title="新建文件夹" onClose={busy ? () => {} : () => setFolderModal(false)}>
          <form onSubmit={makeFolder}>
            <div className="modal-body">
              <label className="field">
                <span>文件夹名称</span>
                <input
                  aria-label="文件夹名称"
                  value={folderName}
                  required
                  maxLength={255}
                  onChange={(event) => setFolderName(event.target.value)}
                  placeholder="例如：backups"
                />
              </label>
              {folderError && <p className="form-error">{folderError}</p>}
            </div>
            <footer className="modal-footer">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setFolderModal(false)}
              >
                取消
              </button>
              <button className="button primary" disabled={busy || !folderName.trim()}>
                {busy ? <Spinner /> : <Plus size={15} />}创建文件夹
              </button>
            </footer>
          </form>
        </Dialog>
      )}
    </>
  );
}

function JobsPage({ jobs, status, openJob, onStop }) {
  const [filter, setFilter] = useState('all');
  const list = jobs.filter(
    (job) =>
      filter === 'all' ||
      (filter === 'running' ? job.status === 'running' : job.status !== 'running'),
  );
  return (
    <>
      <div className="page-title">
        <div>
          <h1>传输任务</h1>
          <p>每一次复制与同步，都有迹可循。</p>
        </div>
        <button className="button primary" disabled={!status?.available} onClick={() => openJob()}>
          <Plus size={16} />
          新建任务
        </button>
      </div>
      <div className="task-summary">
        <span>
          <i className="green-dot" />
          {jobs.filter((job) => job.status === 'running').length} 个运行中
        </span>
        <span>
          <CheckCircle2 size={15} />
          {jobs.filter((job) => job.status === 'completed').length} 个已完成
        </span>
        <span>
          <CircleHelp size={15} />
          {jobs.filter((job) => job.status === 'failed').length} 个失败
        </span>
      </div>
      <section className="panel">
        <div className="tabs">
          {[
            ['all', '全部任务'],
            ['running', '运行中'],
            ['finished', '已结束'],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setFilter(id)}
              className={filter === id ? 'active' : ''}
            >
              {label}
              <span>
                {
                  jobs.filter(
                    (job) =>
                      id === 'all' ||
                      (id === 'running' ? job.status === 'running' : job.status !== 'running'),
                  ).length
                }
              </span>
            </button>
          ))}
        </div>
        <JobTable jobs={list} onStop={onStop} />
      </section>
      <div className="page-note">
        <CircleHelp size={15} />
        任务在后台运行；计划任务按每日额度调度，服务重启后自动恢复。普通任务需重新创建。
      </div>
    </>
  );
}

function PasswordSettings({ passwordRequired, onPasswordChange, notify }) {
  const [values, setValues] = useState({ currentPassword: '', password: '', confirmation: '' });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    setError('');
    if (values.password.length < 12) {
      setError('新密码至少需要 12 位。');
      return;
    }
    if (values.password !== values.confirmation) {
      setError('两次输入的新密码不一致。');
      return;
    }
    setBusy(true);
    try {
      await api(passwordRequired ? '/password' : '/setup', {
        method: passwordRequired ? 'PUT' : 'POST',
        body: passwordRequired
          ? { currentPassword: values.currentPassword, password: values.password }
          : { password: values.password },
      });
      onPasswordChange();
      setValues({ currentPassword: '', password: '', confirmation: '' });
      notify(passwordRequired ? '面板密码已更新' : '面板密码已设置');
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="panel password-settings-panel" onSubmit={submit}>
      <div className="panel-heading">
        <div>
          <h3>面板登录密码</h3>
          <p>
            {passwordRequired
              ? '在网页修改密码；更新后其他已登录会话会退出。'
              : '当前为本机免登录模式，可在这里设置密码，启用登录保护。'}
          </p>
        </div>
        <ShieldCheck size={19} className="muted" />
      </div>
      <div className="settings-body">
        <div className="password-fields">
          {[
            ['currentPassword', '当前密码', 'current-password'],
            ['password', '新密码', 'new-password'],
            ['confirmation', '确认新密码', 'new-password'],
          ]
            .filter(([key]) => passwordRequired || key !== 'currentPassword')
            .map(([key, label, autoComplete]) => (
              <label className="field" key={key}>
                <span>{label}</span>
                <input
                  type="password"
                  aria-label={label}
                  autoComplete={autoComplete}
                  required
                  minLength={key === 'currentPassword' ? undefined : 12}
                  maxLength={1024}
                  value={values[key]}
                  disabled={busy}
                  placeholder={key === 'currentPassword' ? '输入当前密码' : '至少 12 位'}
                  onChange={(event) => setValues((old) => ({ ...old, [key]: event.target.value }))}
                />
              </label>
            ))}
        </div>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </div>
      <footer className="settings-footer">
        <span className="password-help">请保存好新密码，下次登录时使用。</span>
        <button className="button primary" disabled={busy}>
          {busy ? <Spinner /> : <ShieldCheck size={16} />}
          {passwordRequired ? '更新密码' : '设置密码'}
        </button>
      </footer>
    </form>
  );
}

function SettingsPage({ settings, status, onSave, passwordRequired, onPasswordChange, notify }) {
  const [values, setValues] = useState(settings),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    setValues(settings);
  }, [settings]);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const saved = await api('/settings', { method: 'PUT', body: values });
      onSave(saved);
      notify('运行设置已保存');
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-title">
        <div>
          <h1>运行设置</h1>
          <p>网盘连接、账号和传输参数均在网页设置，并保存在挂载的数据目录。</p>
        </div>
      </div>
      <div className="settings-layout">
        <form className="panel settings-panel" onSubmit={submit}>
          <div className="panel-heading">
            <div>
              <h3>传输参数</h3>
              <p>并发和重试设置用于之后新建的任务</p>
            </div>
            <Settings2 size={19} className="muted" />
          </div>
          <div className="settings-body">
            {[
              ['transfers', '同时传输文件数', '并行复制的文件数量。', 1, 64],
              ['checkers', '并行检查数', '同时检查源和目标文件的数量。', 1, 128],
              ['retries', '失败重试次数', '遇到临时错误时，重新尝试的次数。', 1, 20],
            ].map(([key, label, help, min, max]) => (
              <label className="setting-row" key={key}>
                <span>
                  <strong>{label}</strong>
                  <small>{help}</small>
                </span>
                <input
                  type="number"
                  aria-label={label}
                  min={min}
                  max={max}
                  required
                  value={values[key]}
                  onChange={(event) =>
                    setValues((previous) => ({ ...previous, [key]: event.target.value }))
                  }
                />
              </label>
            ))}
            <label className="setting-row">
              <span>
                <strong>全局带宽限制</strong>
                <small>立即应用于所有任务；留空表示不限速。</small>
              </span>
              <input
                aria-label="全局带宽限制"
                placeholder="例如 10M"
                value={values.bandwidth}
                onChange={(event) =>
                  setValues((previous) => ({ ...previous, bandwidth: event.target.value }))
                }
              />
            </label>
            <div className="callout">
              <Activity size={18} />
              <p>10M 表示每秒约 10 MiB；500K 表示每秒约 500 KiB。</p>
            </div>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
          </div>
          <footer className="settings-footer">
            <button
              type="button"
              className="text-button"
              onClick={() => setValues({ transfers: 4, checkers: 8, retries: 3, bandwidth: '' })}
            >
              填入默认值
            </button>
            <button className="button primary" disabled={busy || !status?.available}>
              {busy ? <Spinner /> : <Check size={16} />}保存设置
            </button>
          </footer>
        </form>
        <div className="settings-aside">
          <section className="panel">
            <div className="panel-heading">
              <h3>服务信息</h3>
              <Server size={18} className="muted" />
            </div>
            <dl className="service-info">
              <dt>rclone 版本</dt>
              <dd>{status?.version || '未连接'}</dd>
              <dt>面板版本</dt>
              <dd>{appVersion}</dd>
              <dt>运行时长</dt>
              <dd>{Math.floor((status?.uptime || 0) / 60)} 分钟</dd>
              <dt>配置文件</dt>
              <dd className="code-path">{status?.configPath || '—'}</dd>
              <dt>本地文件目录</dt>
              <dd className="code-path">{status?.localRoot || '—'}</dd>
            </dl>
          </section>
          <div className="settings-tip">
            <ShieldCheck size={24} />
            <h3>为你的连接留一份备份</h3>
            <p>
              修改存储前会自动备份配置。部署时持久化 /data/config 和
              /data/panel，便可保留凭据、设置与任务记录。
            </p>
            <a href="https://rclone.org/docs/" target="_blank" rel="noreferrer">
              查看 rclone 文档
              <ExternalLink size={13} />
            </a>
          </div>
        </div>
      </div>
      <PasswordSettings
        passwordRequired={passwordRequired}
        onPasswordChange={onPasswordChange}
        notify={notify}
      />
      <details className="panel openlist-settings-panel optional-service-settings">
        <summary>可选：OpenList 网盘服务</summary>
        <p className="optional-service-note">
          115、光鸭和 123 当前通过 OpenList 连接；Google Drive、WebDAV、S3
          等可直接添加存储，无需配置此项。
        </p>
        <OpenListSetup onConnected={() => notify('OpenList 服务已连接')} />
      </details>
    </>
  );
}

function Login({ onLogin, setupRequired = false }) {
  const [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <div className="login-screen">
      <div className="login-decoration">
        <Logo />
        <div>
          <span className="eyebrow">YOUR FILES. YOUR FLOW.</span>
          <h1>
            每一处存储，
            <br />
            都在掌握之中。
          </h1>
          <p>从连接到传输，为你的文件找到更清晰的路径。</p>
          <StorageVisual />
        </div>
        <span className="login-caption">CLOUDREEL / MEDIA TRANSFER</span>
      </div>
      <div className="login-main">
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setError('');
            if (setupRequired && password.length < 12) {
              setError('面板密码至少需要 12 位。');
              return;
            }
            if (setupRequired && password !== confirmation) {
              setError('两次输入的密码不一致。');
              return;
            }
            setBusy(true);
            try {
              const result = await api(setupRequired ? '/setup' : '/login', {
                method: 'POST',
                body: { password },
              });
              onLogin(result);
            } catch (error) {
              setError(error.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <span className="login-lock">
            <ShieldCheck size={26} />
          </span>
          <h2>{setupRequired ? '开始使用 CloudReel' : '欢迎回来'}</h2>
          <p>
            {setupRequired
              ? '先设置面板登录密码，再在网页添加网盘和安排传输。'
              : '输入面板密码，进入你的存储工作台。'}
          </p>
          <label className="field">
            <span>面板密码</span>
            <input
              type="password"
              aria-label="面板密码"
              autoComplete={setupRequired ? 'new-password' : 'current-password'}
              required
              minLength={setupRequired ? 12 : undefined}
              maxLength={1024}
              disabled={busy}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={setupRequired ? '设置至少 12 位的密码' : '输入面板密码'}
            />
            {setupRequired && <small>设置完成后，可在运行设置中修改。</small>}
          </label>
          {setupRequired && (
            <label className="field">
              <span>确认面板密码</span>
              <input
                type="password"
                aria-label="确认面板密码"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={1024}
                disabled={busy}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder="再次输入面板密码"
              />
            </label>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <button className="button primary" disabled={busy}>
            {busy ? <Spinner /> : <ArrowRight size={17} />}
            {setupRequired ? '完成设置，进入工作台' : '进入工作台'}
          </button>
          <div className="secure-note">
            <ShieldCheck size={14} />
            这是你的私有存储管理空间
          </div>
        </form>
        <small>CloudReel 影视传输助手 · v{appVersion}</small>
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(null),
    [bootError, setBootError] = useState('');
  const [page, setPage] = useState('media');
  const [viewingJob, setViewingJob] = useState(null);
  const [status, setStatus] = useState(null),
    [remotes, setRemotes] = useState([]),
    [providers, setProviders] = useState([]),
    [jobs, setJobs] = useState([]),
    [schedules, setSchedules] = useState([]);
  const [settings, setSettings] = useState({
      transfers: 4,
      checkers: 8,
      retries: 3,
      bandwidth: '',
    }),
    [history, setHistory] = useState([]);
  const [location, setLocation] = useState({ remote: 'local', path: '' });
  const [modal, setModal] = useState(null),
    [toast, setToast] = useState(null),
    [refreshing, setRefreshing] = useState(false);
  const loadedProviders = useRef(false);
  const [configRevision, setConfigRevision] = useState(0);
  const toastTimer = useRef(null);
  const notify = useCallback((message, type = 'success') => {
    setToast({ message, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);
  useEffect(() => {
    api('/session')
      .then(setSession)
      .catch((error) => setBootError(error.message));
    const expired = () => {
      setSession((previous) => ({ ...previous, authenticated: false }));
      setModal(null);
      setRemotes([]);
      setJobs([]);
      setSchedules([]);
      setProviders([]);
      setStatus(null);
      loadedProviders.current = false;
    };
    window.addEventListener('studio:unauthorized', expired);
    return () => {
      window.removeEventListener('studio:unauthorized', expired);
      clearTimeout(toastTimer.current);
    };
  }, []);
  const refresh = useCallback(
    async (force = false) => {
      const result = await Promise.allSettled([
        api('/status'),
        api('/remotes'),
        api('/jobs'),
        api('/schedules'),
      ]);
      if (result[0].status === 'fulfilled') {
        setStatus(result[0].value);
        setHistory((previous) =>
          [...previous, { speed: result[0].value.stats?.speed || 0, at: Date.now() }].slice(-30),
        );
      } else setStatus({ available: false, error: result[0].reason.message });
      if (result[1].status === 'fulfilled') setRemotes(result[1].value);
      if (result[2].status === 'fulfilled') setJobs(result[2].value);
      if (result[3].status === 'fulfilled') setSchedules(result[3].value);
      const loadProviders =
        !loadedProviders.current && result[0].status === 'fulfilled' && result[0].value.available;
      if (loadProviders || force === true) {
        const configuration = await Promise.allSettled([
          loadProviders ? api('/providers') : Promise.resolve(null),
          api('/settings'),
        ]);
        if (configuration[0].status === 'fulfilled') {
          if (configuration[0].value) setProviders(configuration[0].value);
        } else notify(configuration[0].reason.message, 'error');
        if (configuration[1].status === 'fulfilled') {
          setSettings(configuration[1].value);
          if (force === true) setConfigRevision((previous) => previous + 1);
        } else notify(configuration[1].reason.message, 'error');
        if (loadProviders && configuration.every((item) => item.status === 'fulfilled'))
          loadedProviders.current = true;
      }
    },
    [notify],
  );
  useEffect(() => {
    if (!session?.authenticated) return;
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [session?.authenticated, refresh]);
  function navigate(id, nextLocation) {
    setPage(id);
    if (id !== 'jobs') setViewingJob(null);
    if (nextLocation) setLocation(nextLocation);
    window.scrollTo({ top: 0 });
  }
  function openRemote(remote = null, type = '') {
    setModal({ type: 'remote', remote, initialType: type });
  }
  function openJob(source) {
    setModal({ type: 'job', source });
  }
  function viewJob(id = null) {
    setViewingJob(id);
    navigate('jobs');
  }
  function done(message) {
    setModal(null);
    notify(message);
    refresh();
  }
  function stop(job) {
    setModal({ type: 'stop', job });
  }
  if (bootError)
    return (
      <div className="boot">
        <Logo />
        <Empty
          icon={Server}
          title="面板服务暂时无法连接"
          text={bootError}
          action={
            <button className="button primary" onClick={() => window.location.reload()}>
              重新连接
            </button>
          }
        />
      </div>
    );
  if (!session)
    return (
      <div className="boot">
        <Logo />
        <Spinner />
        <p>正在打开你的工作台…</p>
      </div>
    );
  if (session.setupRequired || !session.authenticated)
    return (
      <Login
        setupRequired={Boolean(session.setupRequired)}
        onLogin={(result) =>
          setSession((previous) => ({
            ...previous,
            ...result,
            authenticated: true,
            passwordRequired: true,
            setupRequired: false,
          }))
        }
      />
    );
  const currentPage = pages.find((item) => item.id === page);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Logo />
        <div className="workspace-tag">
          <span className="workspace-avatar">W</span>
          <span>
            <strong>我的影视库</strong>
            <small>115 → Google Drive</small>
          </span>
          <ChevronRight size={15} />
        </div>
        <span className="nav-caption">工作空间</span>
        <nav aria-label="主导航">
          {pages.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              title={label}
              aria-current={page === id ? 'page' : undefined}
              className={page === id ? 'active' : ''}
              onClick={() => navigate(id)}
            >
              <Icon size={19} />
              <span>{label}</span>
              {id === 'jobs' && jobs.some((job) => job.status === 'running') && (
                <i className="nav-count">{jobs.filter((job) => job.status === 'running').length}</i>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-help">
            <span>
              <Cloud size={19} />
            </span>
            <strong>让存储更简单</strong>
            <p>
              你的文件，
              <br />
              始终由你掌控。
            </p>
            <a href="https://rclone.org/docs/" target="_blank" rel="noreferrer">
              使用文档
              <ArrowUpRightIcon />
            </a>
          </div>
          <a className="help-link" href="https://rclone.org/" target="_blank" rel="noreferrer">
            <BookOpen size={17} />
            <span>rclone 官方文档</span>
            <ExternalLink size={13} />
          </a>
          <div className="sidebar-footer">
            <span className="avatar">C</span>
            <span>
              <strong>CloudReel</strong>
              <small>v{appVersion} · 自托管</small>
            </span>
            {session.passwordRequired && (
              <button
                className="icon-button"
                title="退出登录"
                aria-label="退出登录"
                onClick={async () => {
                  await api('/logout', { method: 'POST', body: {} });
                  loadedProviders.current = false;
                  setSession((previous) => ({ ...previous, authenticated: false }));
                  setRemotes([]);
                  setJobs([]);
                  setSchedules([]);
                  setStatus(null);
                  setHistory([]);
                }}
              >
                <LogOut size={16} />
              </button>
            )}
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="topbar-breadcrumb">
            <span>工作空间</span>
            <ChevronRight size={13} />
            <strong>{currentPage.label}</strong>
          </div>
          <div className="topbar-actions">
            <span className={`engine-status ${status?.available ? '' : 'offline'}`}>
              <i />
              {status?.available ? `rclone ${status.version}` : status ? '服务未连接' : '连接中'}
            </span>
            <span className="header-divider" />
            <button
              className="icon-button"
              aria-label="刷新面板"
              title="刷新面板"
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                await refresh(true);
                setRefreshing(false);
              }}
            >
              <RefreshCw size={17} className={refreshing ? 'spin' : ''} />
            </button>
            <span className="avatar small-avatar">R</span>
          </div>
        </header>
        <div className="page-content">
          {status && !status.available && (
            <div className="offline-banner">
              <Server size={18} />
              <div>
                <strong>rclone 服务未连接</strong>
                <p>{status.error}</p>
              </div>
              <button className="text-button" onClick={refresh}>
                重试
              </button>
            </div>
          )}
          {page === 'overview' && (
            <Dashboard
              remotes={remotes}
              jobs={jobs}
              status={status}
              history={history}
              navigate={navigate}
              openRemote={openRemote}
              openJob={openJob}
            />
          )}
          {page === 'media' && (
            <MediaPage
              remotes={remotes}
              status={status}
              notify={notify}
              refresh={refresh}
              openRemote={openRemote}
              onJob={viewJob}
              onSchedules={() => navigate('schedules')}
            />
          )}
          {page === 'remotes' && (
            <RemotePage
              remotes={remotes}
              status={status}
              openRemote={openRemote}
              openDelete={(remote) => setModal({ type: 'delete', remote })}
              browse={(remote) => navigate('files', { remote, path: '' })}
              notify={notify}
            />
          )}
          {page === 'files' && (
            <FilesPage
              remotes={remotes}
              location={location}
              setLocation={setLocation}
              status={status}
              openJob={openJob}
              notify={notify}
            />
          )}
          {page === 'jobs' && (
            <QueuePage
              key={`queue-${configRevision}`}
              initialJobId={viewingJob}
              jobs={jobs}
              status={status}
              openJob={openJob}
              onStop={stop}
              notify={notify}
              refresh={refresh}
            />
          )}
          {page === 'accounts' && (
            <AccountsPage
              remotes={remotes}
              openRemote={openRemote}
              notify={notify}
              refresh={refresh}
            />
          )}
          {page === 'management' && (
            <ManagementPage
              key={`management-${configRevision}`}
              notify={notify}
              refresh={refresh}
            />
          )}
          {page === 'settings' && (
            <SettingsPage
              settings={settings}
              status={status}
              onSave={setSettings}
              passwordRequired={session.passwordRequired}
              onPasswordChange={() =>
                setSession((previous) => ({
                  ...previous,
                  authenticated: true,
                  passwordRequired: true,
                  setupRequired: false,
                }))
              }
              notify={notify}
            />
          )}
          {page === 'schedules' && (
            <SchedulesPage
              schedules={schedules}
              remotes={remotes}
              status={status}
              refresh={refresh}
              notify={notify}
              openJob={viewJob}
            />
          )}
          <footer className="page-footer">
            <span>CloudReel 影视传输助手</span>
            <span>115 → Google Drive · 定时、定量、持续传输</span>
          </footer>
        </div>
      </main>
      {modal?.type === 'remote' && (
        <RemoteForm
          providers={providers}
          remote={modal.remote}
          initialType={modal.initialType}
          onClose={() => {
            setModal(null);
            refresh();
          }}
          onDone={done}
        />
      )}
      {modal?.type === 'job' && (
        <JobForm
          remotes={remotes}
          source={modal.source}
          onClose={() => setModal(null)}
          onDone={(message) => {
            done(message);
            navigate('jobs');
          }}
        />
      )}
      {modal?.type === 'delete' && (
        <ConfirmDialog
          title={`删除存储 ${modal.remote.name}？`}
          text="这会删除该存储的连接配置，远程文件会保留。删除前会自动备份配置。"
          action="删除存储"
          onClose={() => setModal(null)}
          onConfirm={async () => {
            await api(`/remotes/${encodeURIComponent(modal.remote.name)}`, {
              method: 'DELETE',
              body: {},
            });
            if (location.remote === modal.remote.name) setLocation({ remote: 'local', path: '' });
            done('存储配置已删除');
          }}
        />
      )}
      {modal?.type === 'stop' && (
        <ConfirmDialog
          title="停止这个任务？"
          text="正在进行的传输会被取消。已完成文件保留，稍后可以在详情中恢复任务。"
          action="停止任务"
          onClose={() => setModal(null)}
          onConfirm={async () => {
            await api(`/jobs/${modal.job.id}/stop`, { method: 'POST', body: {} });
            done('已请求停止任务');
          }}
        />
      )}
      {toast && (
        <div role="status" className={`toast ${toast.type}`}>
          {toast.type === 'success' ? <CheckCircle2 size={19} /> : <CircleHelp size={19} />}
          <span>{toast.message}</span>
          <button className="icon-button" aria-label="关闭通知" onClick={() => setToast(null)}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function ArrowUpRightIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M7 17 17 7M7 7h10v10" />
    </svg>
  );
}
