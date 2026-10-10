import test from 'node:test';
import assert from 'node:assert/strict';
import { nextVersion } from '../scripts/version.mjs';

test('CloudReel 补丁位从0到9，达到9后次版本进位', () => {
  for (const [current, next] of [
    ['1.0.0', '1.0.1'],
    ['1.0.8', '1.0.9'],
    ['1.0.9', '1.1.0'],
    ['1.1.9', '1.2.0'],
    ['1.2.9', '1.3.0'],
    ['1.9.9', '1.10.0'],
  ])
    assert.equal(nextVersion(current), next);
});

test('拒绝不符合版本格式的补丁位与后缀', () => {
  for (const version of ['1.0.10', '01.0.0', '1.0', 'v1.0.0', '1.0.0-beta', '1.0.-1'])
    assert.throws(() => nextVersion(version));
});
