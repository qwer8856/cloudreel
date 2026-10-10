import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function nextVersion(version) {
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.([0-9])$/.exec(version);
  if (!parts) throw new Error('版本必须为 主版本.次版本.补丁版本，补丁版本范围为 0–9。');
  const [major, minor, patch] = parts.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) throw new Error('版本号超出允许范围。');
  const nextMinor = patch === 9 ? minor + 1 : minor;
  if (!Number.isSafeInteger(nextMinor)) throw new Error('次版本号超出允许范围。');
  return `${major}.${nextMinor}.${patch === 9 ? 0 : patch + 1}`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--write') || args.length > 1)
    throw new Error('用法：node scripts/version.mjs [--write]');
  const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
  const lockPath = fileURLToPath(new URL('../package-lock.json', import.meta.url));
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  const version = nextVersion(packageJson.version);
  if (args.includes('--write')) {
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    if (
      lock.version !== packageJson.version ||
      lock.packages?.['']?.version !== packageJson.version
    )
      throw new Error('package.json 与 package-lock.json 的版本不一致，请先修复。');
    packageJson.version = lock.version = lock.packages[''].version = version;
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  }
  console.log(version);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
