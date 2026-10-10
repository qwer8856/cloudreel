// Protocol implementation adapted from SheltonZhu/115driver (MIT).
// See THIRD_PARTY_NOTICES.md for the original license.
import { randomBytes } from 'node:crypto';

const seed = Buffer.from(
  'f0e569aebfdcbf8a1a45e8be7da673b8de8fe7c445da86c49b648b146ab4f1aa' +
    '3801359e26692c86006b4fa5363462a62a966818f24afdbd6b978f4d8f8913b7' +
    '6c8e93ed0e0d483ed72f88d8fefe7e8650954fd1eb832634db667b9c7e9d7a81' +
    '32eab633de3aa95934663baaba816048b9d5819cf86c8477ff5478265fbee81e' +
    '369f34805c452c9b76d51b8fccc3b8f5',
  'hex',
);
const clientKey = Buffer.from('7806ad4c33865d184c013f46', 'hex');
const modulus = BigInt(
  '0x' +
    '8686980c0f5a24c4b9d43020cd2c22703ff3f450756529058b1cf88f09b86021' +
    '36477198a6e2683149659bd122c33592fdb5ad47944ad1ea4d36c6b172aad633' +
    '8c3bb6ac6227502d010993ac967d1aef00f0c8e038de2e4d3bc2ec368af2e9f1' +
    '0a6f1eda4f7262f136420c07c331b871bf139f74f3010e3c4fe57df3afb71683',
);
function derive(key, size) {
  return Buffer.from(
    Array.from(
      { length: size },
      (_, i) => ((key[i] + seed[size * i]) & 255) ^ seed[size * (size - i - 1)],
    ),
  );
}
function xor(data, key) {
  const remainder = data.length % 4;
  for (let i = 0; i < data.length; i++)
    data[i] ^= key[(i < remainder ? i : i - remainder) % key.length];
  return data;
}
function rsa(block) {
  let base = BigInt('0x' + block.toString('hex')),
    exponent = 65537n,
    result = 1n;
  if (base >= modulus) throw new Error('Invalid RSA block');
  while (exponent) {
    if (exponent & 1n) result = (result * base) % modulus;
    base = (base * base) % modulus;
    exponent >>= 1n;
  }
  return Buffer.from(result.toString(16).padStart(256, '0'), 'hex');
}
export function encode115(payload, key = randomBytes(16)) {
  const data = xor(xor(Buffer.from(payload), derive(key, 4)).reverse(), clientKey);
  const clear = Buffer.concat([key, data]),
    blocks = [];
  for (let i = 0; i < clear.length; i += 117) {
    const part = clear.subarray(i, i + 117),
      pad = randomBytes(125 - part.length);
    for (let j = 0; j < pad.length; j++) while (!pad[j]) pad[j] = randomBytes(1)[0];
    blocks.push(rsa(Buffer.concat([Buffer.from([0, 2]), pad, Buffer.from([0]), part])));
  }
  return { key, data: Buffer.concat(blocks).toString('base64') };
}
export function decode115(encoded, key) {
  if (typeof encoded !== 'string' || encoded.length > 1024 * 1024)
    throw new Error('Invalid download response');
  const input = Buffer.from(encoded, 'base64'),
    blocks = [];
  if (!input.length || input.length % 128) throw new Error('Invalid download response');
  for (let i = 0; i < input.length; i += 128) {
    const block = rsa(input.subarray(i, i + 128));
    const separator = block.indexOf(0, 2);
    if (separator < 10 || separator === 127) throw new Error('Invalid RSA padding');
    blocks.push(block.subarray(separator + 1));
  }
  const clear = Buffer.concat(blocks);
  if (clear.length < 17) throw new Error('Invalid download response');
  return xor(
    xor(clear.subarray(16), derive(clear.subarray(0, 16), 12)).reverse(),
    derive(key, 4),
  ).toString();
}
