import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

// Original P monogram with a prompt cursor. Shapes only, no font dependency.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([size, name, bytes, crc]);
}
function rounded(x, y, left, top, width, height, radius) {
  const dx = Math.max(left + radius - x, 0, x - (left + width - radius));
  const dy = Math.max(top + radius - y, 0, y - (top + height - radius));
  return x >= left && y >= top && x <= left + width && y <= top + height && dx * dx + dy * dy <= radius * radius;
}
function pixel(x, y) {
  let color = [0, 0, 0, 0];
  const navy = [22, 40, 58, 255];
  if (rounded(x, y, 0, 0, 128, 128, 26)) color = navy;
  const stem = rounded(x, y, 30, 23, 21, 84, 3);
  const bowl = rounded(x, y, 36, 23, 66, 57, 24);
  const cap = rounded(x, y, 31, 23, 45, 21, 3);
  if (stem || bowl || cap) color = [249, 253, 255, 255];
  if (rounded(x, y, 51, 41, 30, 21, 10)) color = navy;
  if (rounded(x, y, 70, 98, 31, 9, 3)) color = [68, 219, 188, 255];
  return color;
}
await mkdir('icons', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sum = [0, 0, 0, 0];
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const rgba = pixel((x + (sx + 0.5) / 4) * 128 / size, (y + (sy + 0.5) / 4) * 128 / size);
      rgba.forEach((c, i) => { sum[i] += c; });
    }
    sum.forEach((c, i) => { rows[y * (size * 4 + 1) + 1 + x * 4 + i] = Math.round(c / 16); });
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  await writeFile(`icons/icon${size}.png`, png);
}
console.log('Generated original Prompt Vault icons: 16, 32, 48, 128');
