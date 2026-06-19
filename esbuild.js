const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    // 'vscode' is provided by the host; 'mssql' is shipped as a node_modules
    // dependency (its driver uses dynamic requires that don't bundle cleanly).
    external: ['vscode', 'mssql'],
    logLevel: 'warning'
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
