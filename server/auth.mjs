import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './validation.mjs';

const derive = promisify(scrypt);
const parameters = { N: 16384, r: 8, p: 1 };

function validatePassword(password, minimum = 12) {
  if (typeof password !== 'string' || password.length < minimum || password.length > 1024)
    throw new AppError(`面板密码需要 ${minimum} 至 1024 位。`);
}

// Authentication stays outside transfer state and configuration backups.
export async function openAuthentication(dataDir, initialPassword = '', minimum = 12) {
  const file = path.join(dataDir, 'auth.json');
  let credential;
  try {
    credential = JSON.parse(await readFile(file, 'utf8'));
    if (
      credential?.version !== 1 ||
      credential.algorithm !== 'scrypt' ||
      !/^[a-f0-9]{64}$/.test(credential.salt || '') ||
      !/^[a-f0-9]{128}$/.test(credential.hash || '')
    )
      throw new Error('Invalid credential');
    await chmod(file, 0o600);
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new Error('面板密码文件无法读取，请检查 DATA_DIR/auth.json。');
  }

  async function replace(password, min = 12) {
    validatePassword(password, min);
    const salt = randomBytes(32);
    const derived = await derive(password, salt, 64, parameters);
    const next = {
      version: 1,
      algorithm: 'scrypt',
      salt: salt.toString('hex'),
      hash: derived.toString('hex'),
    };
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    credential = next;
  }

  if (!credential && initialPassword) await replace(initialPassword, minimum);
  return {
    get configured() {
      return Boolean(credential);
    },
    async verify(password) {
      if (!credential || typeof password !== 'string' || password.length > 1024) return false;
      const derived = await derive(password, Buffer.from(credential.salt, 'hex'), 64, parameters);
      return timingSafeEqual(derived, Buffer.from(credential.hash, 'hex'));
    },
    replace,
  };
}
