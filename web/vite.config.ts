/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { devtilesMiddleware } from './devtiles'

// Serves local PMTiles with Range support. Task 12 mounts a second root at /e2e-tiles.
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

export default defineConfig({
  plugins: [react(), devTiles()],
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
