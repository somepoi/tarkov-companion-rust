// Corner points of SVG path data (absolute; curves contribute their end points), for bounding boxes.
/** Absolute points of an SVG path (M/L/H/V/Z and relative forms; curves use their end points). */
function pathPoints(d) {
  const pts = []
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? []
  let i = 0
  let cmd = ''
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  const num = () => Number(tokens[i++])
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++]
    const rel = cmd === cmd.toLowerCase()
    switch (cmd.toUpperCase()) {
      case 'M':
      case 'L': {
        const nx = num()
        const ny = num()
        x = rel ? x + nx : nx
        y = rel ? y + ny : ny
        if (cmd.toUpperCase() === 'M') {
          sx = x
          sy = y
          cmd = rel ? 'l' : 'L'
        }
        pts.push([x, y])
        break
      }
      case 'H':
        x = rel ? x + num() : num()
        pts.push([x, y])
        break
      case 'V':
        y = rel ? y + num() : num()
        pts.push([x, y])
        break
      case 'C': {
        const v = [num(), num(), num(), num(), num(), num()]
        x = rel ? x + v[4] : v[4]
        y = rel ? y + v[5] : v[5]
        pts.push([x, y])
        break
      }
      case 'S':
      case 'Q': {
        const v = [num(), num(), num(), num()]
        x = rel ? x + v[2] : v[2]
        y = rel ? y + v[3] : v[3]
        pts.push([x, y])
        break
      }
      case 'T': {
        const nx = num()
        const ny = num()
        x = rel ? x + nx : nx
        y = rel ? y + ny : ny
        pts.push([x, y])
        break
      }
      case 'A': {
        const v = [num(), num(), num(), num(), num(), num(), num()]
        x = rel ? x + v[5] : v[5]
        y = rel ? y + v[6] : v[6]
        pts.push([x, y])
        break
      }
      case 'Z':
        x = sx
        y = sy
        break
      default:
        i++
    }
  }
  return pts
}
module.exports = { pathPoints }
