// MapLibre never retries a failed tile, so one dropped request (flaky mobile data, a 502) leaves a permanent
// hole in the map. Retry tile reads a couple of times with a short backoff; aborted reads are left alone.

type Handler<P, R> = (params: P, abort: AbortController) => Promise<R>

export function withRetry<P, R>(handler: Handler<P, R>, { retries = 2, delayMs = 400 } = {}): Handler<P, R> {
  return async (params, abort) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await handler(params, abort)
      } catch (err) {
        if (abort.signal.aborted || attempt >= retries) throw err
        await new Promise((r) => setTimeout(r, delayMs * 2 ** attempt))
        if (abort.signal.aborted) throw err
      }
    }
  }
}
