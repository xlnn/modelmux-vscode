'use strict';

const path = require('path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
sharp(path.join(root, 'media', 'modelmux-color.svg'))
  .resize(256, 256)
  .png({ compressionLevel: 9, palette: true })
  .toFile(path.join(root, 'media', 'modelmux.png'))
  .then(() => console.log('Generated media/modelmux.png'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
