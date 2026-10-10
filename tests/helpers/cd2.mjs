import { createServer } from 'node:http';

const xml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
export async function mockCd2() {
  const rootPath = '115（主号）/电影 100%';
  const files = new Map([
    [`/dav/${rootPath}/动画/影片.mkv`, Buffer.from('synthetic CD2 video bytes\n')],
    [`/dav/${rootPath}/动画/影片.srt`, Buffer.from('synthetic CD2 subtitle\n')],
    [`/dav/${rootPath}/动画/影片:特别篇.mkv`, Buffer.from('synthetic CD2 colon video\n')],
    ['/dav/另一网盘/外部.txt', Buffer.from('out of scope')],
  ]);
  const requests = [];
  let anonymous = false,
    failure = 0;
  const username = 'synthetic-cd2@example.invalid',
    password = 'synthetic-CD2-password';
  const server = createServer(async (req, res) => {
    for await (const part of req) void part;
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/';
    requests.push({
      method: req.method,
      path: pathname,
      depth: req.headers.depth,
      authenticated: Boolean(req.headers.authorization),
    });
    if (failure) {
      res.writeHead(failure);
      res.end('synthetic-CD2-password');
      return;
    }
    if (
      !anonymous &&
      req.headers.authorization !==
        `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    ) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="synthetic-cd2"' });
      res.end('synthetic-CD2-password');
      return;
    }
    const isDir = (p) => [...files.keys()].some((file) => file.startsWith(`${p}/`));
    if (!files.has(pathname) && !isDir(pathname)) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.method === 'PROPFIND') {
      const paths = [pathname];
      if (req.headers.depth !== '0' && isDir(pathname)) {
        const children = new Set(
          [...files.keys()]
            .filter((file) => file.startsWith(`${pathname}/`))
            .map((file) => `${pathname}/${file.slice(pathname.length + 1).split('/')[0]}`),
        );
        paths.push(...children);
      }
      const body = paths
        .map(
          (p) =>
            `<d:response><d:href>${xml(p.split('/').map(encodeURIComponent).join('/') + (isDir(p) ? '/' : ''))}</d:href><d:propstat><d:prop><d:displayname>${xml(p.split('/').at(-1))}</d:displayname><d:resourcetype>${isDir(p) ? '<d:collection/>' : ''}</d:resourcetype><d:getcontentlength>${files.get(p)?.length || 0}</d:getcontentlength><d:getlastmodified>Thu, 01 Jan 1970 00:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
        )
        .join('');
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`);
      return;
    }
    if (['GET', 'HEAD'].includes(req.method) && files.has(pathname)) {
      const content = files.get(pathname);
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      const start = range ? Number(range[1]) : 0,
        end = range?.[2] ? Math.min(Number(range[2]), content.length - 1) : content.length - 1;
      if (start >= content.length) {
        res.writeHead(416);
        res.end();
        return;
      }
      res.writeHead(range ? 206 : 200, {
        'Content-Length': String(end - start + 1),
        'Content-Type': 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${content.length}` } : {}),
      });
      res.end(req.method === 'HEAD' ? undefined : content.subarray(start, end + 1));
      return;
    }
    res.writeHead(405);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/dav`,
    rootPath,
    username,
    password,
    files,
    requests,
    fail: (status) => {
      failure = status;
    },
    anonymous: (value) => {
      anonymous = value;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
