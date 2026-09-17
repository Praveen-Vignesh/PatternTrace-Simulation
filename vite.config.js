import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Stamp the app version onto every session row (constants.js reads
// __APP_VERSION__). Sourced from package.json so a release bump is the single
// place it changes; falls back to 'dev' outside a Vite build (Node harnesses).
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));

export default defineConfig({
  // Relative asset paths so the built dist/ runs from any static host or subpath.
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  build: {
    // Three.js alone exceeds the default 500 kB advisory limit, and it is needed
    // on the first frame, so splitting it out would move bytes without saving any.
    chunkSizeWarningLimit: 800,
    // Multi-page, not a router: privacy.html is a static document with no shared
    // JS, so it ships as its own entry and never pulls in Three or the game.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        privacy: fileURLToPath(new URL('./privacy.html', import.meta.url))
      }
    }
  }
});
