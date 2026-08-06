import * as esbuild from 'esbuild';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');

mkdirSync(dist, { recursive: true });

const sharedOpts = {
  bundle: true,
  target: 'chrome120',
  sourcemap: true,
  logLevel: 'info',
};

async function buildOnce() {
  // Wipe previous JS/HTML/CSS but keep folder
  for (const name of [
    'background.js',
    'background.js.map',
    'content.js',
    'content.js.map',
    'sidepanel.js',
    'sidepanel.js.map',
    'sidepanel.css',
    'sidepanel.css.map',
    'sidepanel.html',
    'manifest.json',
  ]) {
    try {
      rmSync(join(dist, name), { force: true });
    } catch {
      /* ignore */
    }
  }

  await esbuild.build({
    ...sharedOpts,
    entryPoints: [join(root, 'src/background/index.ts')],
    outfile: join(dist, 'background.js'),
    format: 'esm',
    platform: 'browser',
  });

  await esbuild.build({
    ...sharedOpts,
    entryPoints: [join(root, 'src/content/index.ts')],
    outfile: join(dist, 'content.js'),
    format: 'iife',
    platform: 'browser',
  });

  await esbuild.build({
    ...sharedOpts,
    entryPoints: [join(root, 'src/sidepanel/main.ts')],
    outfile: join(dist, 'sidepanel.js'),
    format: 'esm',
    platform: 'browser',
  });

  // Side panel CSS
  const css = readFileSync(join(root, 'src/sidepanel/styles.css'), 'utf8');
  writeFileSync(join(dist, 'sidepanel.css'), css);

  // Side panel HTML (script/css point at dist siblings)
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pleo</title>
    <link rel="stylesheet" href="sidepanel.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="sidepanel.js"></script>
  </body>
</html>
`;
  writeFileSync(join(dist, 'sidepanel.html'), html);

  copyFileSync(join(root, 'manifest.json'), join(dist, 'manifest.json'));
  console.log('Build complete → extension/dist/');
}

if (watch) {
  const ctxBg = await esbuild.context({
    ...sharedOpts,
    entryPoints: [join(root, 'src/background/index.ts')],
    outfile: join(dist, 'background.js'),
    format: 'esm',
    platform: 'browser',
  });
  const ctxCs = await esbuild.context({
    ...sharedOpts,
    entryPoints: [join(root, 'src/content/index.ts')],
    outfile: join(dist, 'content.js'),
    format: 'iife',
    platform: 'browser',
  });
  const ctxSp = await esbuild.context({
    ...sharedOpts,
    entryPoints: [join(root, 'src/sidepanel/main.ts')],
    outfile: join(dist, 'sidepanel.js'),
    format: 'esm',
    platform: 'browser',
    plugins: [
      {
        name: 'copy-static',
        setup(build) {
          build.onEnd(() => {
            const css = readFileSync(
              join(root, 'src/sidepanel/styles.css'),
              'utf8'
            );
            writeFileSync(join(dist, 'sidepanel.css'), css);
            writeFileSync(
              join(dist, 'sidepanel.html'),
              `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pleo</title>
    <link rel="stylesheet" href="sidepanel.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="sidepanel.js"></script>
  </body>
</html>
`
            );
            copyFileSync(
              join(root, 'manifest.json'),
              join(dist, 'manifest.json')
            );
          });
        },
      },
    ],
  });
  await Promise.all([ctxBg.watch(), ctxCs.watch(), ctxSp.watch()]);
  console.log('Watching…');
} else {
  await buildOnce();
}
