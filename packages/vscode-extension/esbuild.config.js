const esbuild = require('esbuild');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode', 'better-sqlite3'],
  format: 'cjs',
  platform: 'node',
  sourcemap: !production,
  minify: production,
  target: 'node20',
  // Resolve imports from cto-dashboard source
  alias: {
    '@gentyr/data-reader': path.resolve(__dirname, '../cto-dashboard/src/utils/data-reader.ts'),
    '@gentyr/deputy-cto-reader': path.resolve(__dirname, '../cto-dashboard/src/utils/deputy-cto-reader.ts'),
    '@gentyr/formatters': path.resolve(__dirname, '../cto-dashboard/src/utils/formatters.ts'),
  },
  loader: { '.ts': 'ts' },
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ['src/webview/index.tsx'],
  bundle: true,
  outfile: 'dist/webview.js',
  format: 'iife',
  platform: 'browser',
  sourcemap: !production,
  minify: production,
  target: 'es2020',
  loader: { '.ts': 'ts', '.tsx': 'tsx', '.css': 'css' },
  define: {
    'process.env.NODE_ENV': production ? '"production"' : '"development"',
  },
};

async function build() {
  if (watch) {
    const extensionCtx = await esbuild.context(extensionConfig);
    const webviewCtx = await esbuild.context(webviewConfig);
    await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
    ]);
    console.log('Build complete!');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
