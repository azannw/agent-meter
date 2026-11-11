'use strict';
// Writes assets/icon.png (256 px) and assets/icon.ico (16..256, multi-size)
// from the same rasteriser the tray uses. Run: node scripts/make-icons.js
const fs = require('node:fs');
const path = require('node:path');
const { encodePNG, encodeICO } = require('../src/main/png');
const { appIconRGBA } = require('../src/main/icon');

const assets = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assets, { recursive: true });

const png = encodePNG(256, 256, appIconRGBA(256));
fs.writeFileSync(path.join(assets, 'icon.png'), png);

const sizes = [16, 20, 24, 32, 40, 48, 64, 256];
const ico = encodeICO(sizes.map((size) => ({ size, rgba: appIconRGBA(size) })));
fs.writeFileSync(path.join(assets, 'icon.ico'), ico);

console.log(`assets/icon.png ${png.length} bytes; assets/icon.ico ${ico.length} bytes (${sizes.join(', ')} px)`);
