import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

function appShell(): Plugin {
  return {
    name: 'app-shell',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).map((file) => `/${file}`);
      const hash = createHash('sha256').update(JSON.stringify(Object.values(bundle).map((item) =>
        item.type === 'chunk' ? item.code : item.source)));
      for (const file of ['manifest.webmanifest', 'icon-192.png', 'icon-512.png']) {
        hash.update(readFileSync(`public/${file}`));
      }
      const version = hash.digest('hex').slice(0, 16);
      const assets = ['/', ...files, '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: readFileSync('src/service-worker.js', 'utf8')
          .replace('__CACHE__', JSON.stringify(`flashcards-${version}`))
          .replace('__ASSETS__', JSON.stringify(assets)),
      });
    },
  };
}

export default defineConfig({ plugins: [svelte(), appShell()], build: { target: 'esnext' }, server: { port: 3000, strictPort: true } });
