/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { checkBuildEnv } from './buildenv'
import { devtilesMiddleware } from './devtiles'
import { glyphFallback } from './glyphfallback'

// Serves local PMTiles with Range support: real pipeline output at /tiles, e2e fixtures at /e2e-tiles.
const devTiles = (mounts: Record<string, string> = { '/tiles': '../pipeline/out' }): Plugin => {
  const mount = (use: (path: string, mw: ReturnType<typeof devtilesMiddleware>) => void) => {
    for (const [path, dir] of Object.entries(mounts)) use(path, devtilesMiddleware(resolve(__dirname, dir)))
  }
  return {
    name: 'devtiles',
    configureServer: (server) => mount((p, mw) => server.middlewares.use(p, mw)),
    configurePreviewServer: (server) => mount((p, mw) => server.middlewares.use(p, mw)),
  }
}

export default defineConfig(({ command, mode }) => {
  if (command === 'build') checkBuildEnv({ ...loadEnv(mode, __dirname, 'VITE_'), ...process.env })
  return {
    plugins: [
      react(),
      devTiles({ '/tiles': '../pipeline/out', '/e2e-tiles': 'e2e/fixtures/tiles' }),
      glyphFallback(resolve(__dirname, 'public/glyphs')),
    ],
    build: {
      chunkSizeWarningLimit: 900, // the map-vendor chunk (~820 kB, ~225 kB gzip) is expected to be large
      rollupOptions: {
        // Only the app is built. render/index.html (the map-picture render page used by scripts/render-maps.mjs)
        // is served by the dev server only and never ships.
        input: resolve(__dirname, 'index.html'),
        // MapLibre and PMTiles are most of the bundle and change rarely: their own chunk caches across app releases.
        output: { manualChunks: { 'map-vendor': ['maplibre-gl', 'pmtiles'] } },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['src/test/setup.ts'],
      include: ['tests/**/*.test.{ts,tsx}'],
    },
  }
})
