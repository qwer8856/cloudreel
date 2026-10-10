import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

export async function mockOpenList() {
  const storages = new Map(),
    users = [],
    requests = [];
  let nextId = 1,
    expire = false,
    failCreate = false,
    noUpload = false,
    smsFail = false;
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    const body = text ? JSON.parse(text) : null;
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ path: url.pathname, body, token: req.headers.authorization });
    const send = (data = null, code = 200, message = 'success') => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code, message, data }));
    };
    if (url.pathname === '/api/auth/login/hash') {
      const expected = createHash('sha256')
        .update('synthetic-admin-password-https://github.com/alist-org/alist')
        .digest('hex');
      return body.username === 'admin' && body.password === expected
        ? send({ token: 'synthetic-session-token' })
        : send(null, 401, 'sensitive synthetic-password');
    }
    if (expire) {
      expire = false;
      return send(null, 401, 'token expired');
    }
    if (!['synthetic-session-token', 'synthetic-api-token'].includes(req.headers.authorization))
      return send(null, 401);
    if (url.pathname === '/api/admin/driver/names')
      return send(['115 Cloud', '115 Open', '123Pan', '123 Open', 'GuangYaPan']);
    if (url.pathname === '/api/admin/driver/info') return send({ config: { no_upload: noUpload } });
    if (url.pathname === '/api/admin/user/list')
      return send({ content: users, total: users.length });
    if (url.pathname === '/api/admin/user/create') {
      users.push({ ...body, id: users.length + 1 });
      return send();
    }
    if (url.pathname === '/api/admin/storage/list')
      return send({ content: [...storages.values()], total: storages.size });
    if (url.pathname === '/api/admin/storage/get')
      return storages.has(Number(url.searchParams.get('id')))
        ? send(storages.get(Number(url.searchParams.get('id'))))
        : send(null, 500, 'record not found');
    if (url.pathname === '/api/admin/storage/delete') {
      storages.delete(Number(url.searchParams.get('id')));
      return send();
    }
    if (['/api/admin/storage/create', '/api/admin/storage/update'].includes(url.pathname)) {
      const id = body.id || nextId++;
      const addition = JSON.parse(body.addition);
      if (body.driver === 'GuangYaPan') {
        if (addition.send_code && !smsFail) {
          addition.send_code = false;
          addition.verification_id = 'synthetic-verification-session';
          addition.device_id = 'generated-device';
        }
        if (addition.verify_code === '123456' && addition.verification_id) {
          addition.access_token = 'synthetic-access';
          addition.refresh_token = 'synthetic-refresh';
          addition.verify_code = '';
          addition.verification_id = '';
        }
      }
      storages.set(id, {
        ...body,
        id,
        status: failCreate ? 'login failed with private value' : 'work',
        addition: JSON.stringify(addition),
      });
      return failCreate
        ? send({ id }, 500, 'cookie=synthetic-cookie; sensitive body')
        : send({ id });
    }
    send(null, 404);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    storages,
    users,
    requests,
    expire: () => {
      expire = true;
    },
    fail: (value) => {
      failCreate = value;
    },
    readOnly: (value) => {
      noUpload = value;
    },
    smsFail: (value) => {
      smsFail = value;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
