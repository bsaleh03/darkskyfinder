// Dev-only: list distinct subtype/class/etc. values per source-layer for one tile.
// Usage: node scripts/inspect-tile.mjs <file.pmtiles> [z] [lon] [lat]
import { PMTiles } from 'pmtiles'
import fs from 'node:fs'
import { VectorTile } from '@mapbox/vector-tile'
import Pbf from 'pbf'
import zlib from 'node:zlib'

const [file, z = '12', lon = '-83.10', lat = '42.40'] = process.argv.slice(2)
const Z = Number(z)
const n = 2 ** Z
const x = Math.floor(((Number(lon) + 180) / 360) * n)
const r = (Number(lat) * Math.PI) / 180
const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)
const p = new PMTiles({
  getKey: () => file,
  async getBytes(offset, length) {
    const fh = await fs.promises.open(file, 'r')
    const b = Buffer.alloc(length)
    await fh.read(b, 0, length, offset)
    await fh.close()
    return { data: b.buffer.slice(b.byteOffset, b.byteOffset + length) }
  },
})
const res = await p.getZxy(Z, x, y)
if (!res) { console.log('no tile', Z, x, y); process.exit(0) }
let buf = Buffer.from(res.data)
if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf)
const vt = new VectorTile(new Pbf(buf))
for (const [name, layer] of Object.entries(vt.layers)) {
  const keys = {}
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i)
    for (const k of ['subtype', 'class', 'subclass', 'names', 'road_surface']) {
      if (k in f.properties) (keys[k] ??= new Map()).set(String(f.properties[k]).slice(0, 40), (keys[k].get(String(f.properties[k]).slice(0, 40)) ?? 0) + 1)
    }
    keys._props ??= new Set()
    Object.keys(f.properties).forEach((k) => keys._props.add(k))
  }
  console.log(`== ${name} (${layer.length})`)
  for (const [k, v] of Object.entries(keys)) {
    if (k === '_props') console.log('  props:', [...v].join(','))
    else if (k !== 'names') console.log(' ', k, [...v].slice(0, 25).map(([a, b]) => `${a}:${b}`).join(' '))
  }
}
