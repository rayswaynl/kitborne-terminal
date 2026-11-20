const path = require('node:path');
const sharp = require('sharp');

async function main() {
  const [root, output, ...images] = process.argv.slice(2);
  if (!images.length) throw new Error('No angle stills');
  sharp.concurrency(1); sharp.cache(false);
  const size = 384, cols = 3;
  const tiles = await Promise.all(images.map(async (name, i) => ({
    input: await sharp(path.join(root, name)).resize(size, size, {fit: 'contain'}).png().toBuffer(),
    left: (i % cols) * size, top: Math.floor(i / cols) * size,
  })));
  await sharp({create: {width: cols * size, height: Math.ceil(images.length / cols) * size,
    channels: 3, background: '#202329'}}).composite(tiles).png().toFile(path.join(root, output));
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
