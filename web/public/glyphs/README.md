# Self-hosted map glyphs

SDF glyph PBFs for MapLibre text layers, served from `${BASE_URL}glyphs/{fontstack}/{range}.pbf`.

- Fontstacks: `Noto Sans Regular`, `Noto Sans Bold`
- Ranges shipped: 0-255, 256-511, 8192-8447 (Latin, Latin Extended, general punctuation). Total about 478 KB.
- Source: openmaptiles/fonts release v2.0 (https://github.com/openmaptiles/fonts), prebuilt from Noto Sans.
- License: SIL Open Font License 1.1 (Noto Sans, Google / Noto Project authors).
- Why not Manrope: generating Manrope SDF glyphs needs `fontnik`, which has no prebuilt binary for Node 24 on Windows (native build failed). To switch later, generate Manrope PBFs into this folder with fontnik on a machine where it builds and change the font names in `src/map/style.ts`.
