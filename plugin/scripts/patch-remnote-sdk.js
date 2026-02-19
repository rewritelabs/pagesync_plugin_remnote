const fs = require('fs');
const path = require('path');

const sdkDistPath = path.join(
  __dirname,
  '..',
  'node_modules',
  '@remnote',
  'plugin-sdk',
  'dist',
  'index.js',
);

function patchSdk() {
  if (!fs.existsSync(sdkDistPath)) {
    console.warn('[patch-remnote-sdk] SDK dist file not found, skipping patch');
    return;
  }

  const source = fs.readFileSync(sdkDistPath, 'utf8');

  const target = 'if(!ve(s.eventId))throw"Invalid event "+s.eventId;';
  const replacement =
    'if(!ve(s.eventId)){console.warn("[remnote-sdk-compat] Ignoring unknown event",s.eventId);return;}';

  if (source.includes(replacement)) {
    console.log('[patch-remnote-sdk] already patched');
    return;
  }

  if (!source.includes(target)) {
    console.warn('[patch-remnote-sdk] target pattern not found; SDK may have changed');
    return;
  }

  const patched = source.replace(target, replacement);
  fs.writeFileSync(sdkDistPath, patched, 'utf8');
  console.log('[patch-remnote-sdk] patch applied');
}

patchSdk();
