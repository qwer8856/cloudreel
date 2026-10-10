export async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new Error('无法连接面板服务，请检查服务是否运行。');
  }
  const data = await response.json();
  if (!response.ok) {
    if (
      response.status === 401 &&
      !['/login', '/setup'].includes(path) &&
      (path !== '/password' || data.code === 'AUTH_REQUIRED')
    )
      window.dispatchEvent(new Event('studio:unauthorized'));
    const error = new Error(data.error || '请求失败。');
    error.status = response.status;
    throw error;
  }
  return data;
}

export function bytes(value = 0) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
export function time(value) {
  return value
    ? new Date(value).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
}
export function providerInfo(type) {
  return (
    {
      'openlist-115': {
        title: '115 网盘',
        subtitle: 'OpenList / 直接扫码 / 直接 CK',
        color: 'blue',
        short: '115',
      },
      'openlist-guangya': {
        title: '光鸭云盘',
        subtitle: '短信 / 令牌登录',
        color: 'orange',
        short: '鸭',
      },
      'direct-115': {
        title: '115 网盘',
        subtitle: '直接扫码 / CK，无需 OpenList',
        color: 'blue',
        short: '115',
      },
      'drive-group': {
        title: 'Google 团队盘 group',
        subtitle: '多账号额度与自动切换',
        color: 'green',
        short: 'G',
      },
      'openlist-123': {
        title: '123 网盘',
        subtitle: '账号密码 / 开发者授权',
        color: 'blue',
        short: '123',
      },
      'cd2-webdav': {
        title: 'CD2 WebDAV',
        subtitle: '读取 CD2 中的 115，传到 Google group',
        color: 'blue',
        short: 'CD2',
      },
      webdav: {
        title: 'WebDAV',
        subtitle: '连接 Alist、Nextcloud 等存储',
        color: 'blue',
        short: 'W',
      },
      s3: {
        title: 'S3 对象存储',
        subtitle: 'AWS、MinIO、Cloudflare R2',
        color: 'orange',
        short: 'S3',
      },
      sftp: { title: 'SFTP', subtitle: '通过 SSH 连接远程服务器', color: 'purple', short: 'S' },
      drive: {
        title: 'Google Drive',
        subtitle: '连接你的 Google 云端硬盘',
        color: 'green',
        short: 'G',
      },
      onedrive: {
        title: 'OneDrive',
        subtitle: '个人与 Microsoft 365 云存储',
        color: 'blue',
        short: 'O',
      },
      local: { title: '本地存储', subtitle: '服务器映射的文件目录', color: 'gray', short: 'L' },
      dropbox: { title: 'Dropbox', subtitle: '连接 Dropbox 云存储', color: 'blue', short: 'D' },
      alias: { title: '存储别名', subtitle: '引用已有存储或路径', color: 'gray', short: 'A' },
    }[type] || {
      title: type,
      subtitle: 'rclone 存储后端',
      color: 'gray',
      short: type?.slice(0, 2).toUpperCase() || '?',
    }
  );
}
