const REQUIRED = ['VITE_API_URL', 'VITE_TILES_URL'] as const

/**
 * Render sets RENDER=true in its build environment. A production build there without the API or
 * tiles URL would silently fall back to localhost defaults, so fail the build instead.
 * Local builds (no RENDER) are not checked.
 */
export function checkBuildEnv(env: Record<string, string | undefined>): void {
  if (!env.RENDER) return
  const missing = REQUIRED.filter((k) => !env[k]?.trim())
  if (missing.length) {
    throw new Error(
      `Render build is missing ${missing.join(', ')}. Set ${missing.length > 1 ? 'them' : 'it'} on the darksky-web service ` +
        '(Environment) so the site points at the deployed API and tiles.',
    )
  }
}
