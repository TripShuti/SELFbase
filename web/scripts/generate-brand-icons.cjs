/** Regenerate ICO and Apple icon from app/icon.svg: node web/scripts/generate-brand-icons.cjs */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const sharp = createRequire(require.resolve('next/package.json'))('sharp');
const app = path.resolve(__dirname, '../app');

async function main() {
  // SVG follows the browser color scheme; bitmap fallbacks use a dark tile.
  const svg = fs.readFileSync(path.join(app, 'icon.svg'), 'utf8')
    .replace(/<style>.*?<\/style>/s, '<style>path{stroke:#fafafa}</style>')
    .replace('<g transform=', '<rect width="40" height="40" rx="9" fill="#171717"/><g transform=');
  const sizes = [16, 32, 48];
  const images = await Promise.all(sizes.map(size => sharp(Buffer.from(svg)).resize(size, size).png().toBuffer()));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  images.forEach((image, i) => {
    const entry = 6 + i * 16;
    header[entry] = sizes[i];
    header[entry + 1] = sizes[i];
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  fs.writeFileSync(path.join(app, 'favicon.ico'), Buffer.concat([header, ...images]));
  await sharp(Buffer.from(svg)).resize(180, 180).png().toFile(path.join(app, 'apple-icon.png'));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
