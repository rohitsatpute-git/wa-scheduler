// Renders the icon SVG to the PNGs @capacitor/assets expects. Run: node assets/render.mjs
import sharp from 'sharp'
import { readFileSync } from 'node:fs'
const svg = readFileSync(new URL('./icon.svg', import.meta.url), 'utf8')
const bg = svg.replace(/<g id="fg">[\s\S]*<\/g>/, '')
const fgOnly = svg.replace(/<rect[^>]*\/>/, '')
// Adaptive-icon foreground must fit Android's 66% safe zone: shrink it onto a transparent canvas.
const fg = fgOnly.replace('<g id="fg">', '<g id="fg" transform="translate(512 512) scale(0.82) translate(-512 -512)">')
const out = (name, s, size = 1024) => sharp(Buffer.from(s)).resize(size, size).png().toFile(new URL(name, import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))
await out('icon-only.png', svg)
await out('icon-foreground.png', fg)
await out('icon-background.png', bg)
const splash = (dark) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2732 2732"><rect width="2732" height="2732" fill="${dark ? '#111513' : '#f4f5f2'}"/><g transform="translate(1366 1366) scale(0.6) translate(-512 -512)">${svg.replace(/^<svg[^>]*>|<\/svg>\s*$/g, '')}</g></svg>`
await out('play-icon-512.png', svg, 512) // Play Console store icon
await out('splash.png', splash(false), 2732)
await out('splash-dark.png', splash(true), 2732)
console.log('rendered')
