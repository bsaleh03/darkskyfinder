/** Count pixels (RGBA) that are visible (alpha > 0) and have green or blue above half of red. */
export function redViolations(rgba: Uint8Array | Buffer): number {
  let n = 0
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue
    const half = rgba[i] / 2
    if (rgba[i + 1] > half || rgba[i + 2] > half) n++
  }
  return n
}

/**
 * Cap green and blue at half of red (in place) on visible pixels. Resampling a red image can nudge a few
 * low-alpha pixels over the line through rounding; this keeps the written red variants inside the rule.
 */
export function clampRed(rgba: Uint8Array | Buffer): void {
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue
    const half = rgba[i] >> 1
    if (rgba[i + 1] > half) rgba[i + 1] = half
    if (rgba[i + 2] > half) rgba[i + 2] = half
  }
}
