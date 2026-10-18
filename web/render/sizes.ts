/** The fixed set of picture sizes: quarter, half and full width (ascending), heights from the region aspect. */
export function sizesFor(fullWidth: number, aspect: number): { w: number; h: number }[] {
  return [fullWidth / 4, fullWidth / 2, fullWidth].map((w) => ({ w, h: Math.round(w * aspect) }))
}
