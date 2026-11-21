// Draws the report's charts from #report-data at the page's actual width; everything else is static HTML.
;(() => {
  const source = document.getElementById('report-data')
  if (!source) return
  const data = JSON.parse(source.textContent || '{}')
  const NS = 'http://www.w3.org/2000/svg'

  const mk = (tag, attrs, parent) => {
    const node = document.createElementNS(NS, tag)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
    if (parent) parent.appendChild(node)
    return node
  }
  const text = (parent, x, y, value, cls = 'tx', anchor = 'start') => {
    const node = mk('text', { x, y, class: cls, 'text-anchor': anchor }, parent)
    node.textContent = value
    return node
  }
  const ruler = document.createElement('canvas').getContext('2d')
  const font = getComputedStyle(document.body).fontFamily
  const width = (value, size) => {
    if (!ruler) return value.length * size
    ruler.font = `${size}px ${font}`
    return ruler.measureText(value).width
  }
  const fit = (value, px, size) => {
    if (width(value, size) <= px) return value
    const chars = [...value]
    while (chars.length > 1 && width(`${chars.join('')}…`, size) > px) chars.pop()
    return `${chars.join('')}…`
  }
  const canvas = (host, w, h) => {
    host.textContent = ''
    return mk(
      'svg',
      { width: w, height: h, viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': host.dataset.label },
      host
    )
  }
  const roundTop = (x, y, w, h) => {
    const r = Math.max(0, Math.min(2, w / 2, h))
    return `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`
  }

  // Room activity on top, then a lane per flagged user: ticks are danmaku, bars are flagged stretches. Seconds throughout.
  function timeline(host) {
    const period = data.periods[Number(host.dataset.period)]
    const W = host.clientWidth
    if (!period || !W) return
    const nameW = Math.min(124, Math.round(W * 0.3))
    const x0 = nameW + 10
    const x1 = W - 8
    const x = s => x0 + (Math.max(0, Math.min(period.span, s)) / period.span) * (x1 - x0)
    const top = 6
    const areaH = 40
    const rowH = 20
    const rowsTop = top + areaH + 14
    const axisH = 22
    const H = rowsTop + period.lanes.length * rowH + axisH
    const svg = canvas(host, W, H)

    let edge = Number.NEGATIVE_INFINITY
    for (const [at, value] of period.ticks) {
      const tx = x(at)
      mk('line', { x1: tx, x2: tx, y1: top, y2: H - axisH + 2, class: 'grid' }, svg)
      const half = width(value, 11.5) / 2
      if (tx - half < Math.max(0, edge + 10) || tx + half > W) continue
      text(svg, tx, H - 6, value, 'tx', 'middle')
      edge = tx + half
    }

    const peak = Math.max(1, ...period.counts)
    const base = top + areaH
    const points = period.counts.map(
      (c, i) => `${x((i + 0.5) * period.bucket).toFixed(1)} ${(base - (c / peak) * areaH).toFixed(1)}`
    )
    mk('path', { d: `M${x0} ${base}L${points.join('L')}L${x1} ${base}Z`, class: 'area' }, svg)
    mk('path', { d: `M${points.join('L')}`, class: 'area-line' }, svg)
    text(svg, nameW, top + 13, data.room, 'tx ink', 'end')
    text(svg, nameW, top + 27, `峰值 ${peak} ${period.unit}`, 'tx', 'end')

    period.lanes.forEach((lane, i) => {
      const y0 = rowsTop + i * rowH
      const cy = y0 + 7
      const link = mk('a', { href: lane.href }, svg)
      text(link, nameW, cy + 4, fit(lane.name, nameW - 4, 11.5), 'tx ink', 'end')
      mk('line', { x1: x0, x2: x1, y1: cy, y2: cy, class: 'grid' }, svg)
      const bins = new Map()
      for (const s of lane.sends) {
        const b = Math.floor((x(s) - x0) / 2)
        bins.set(b, (bins.get(b) || 0) + 1)
      }
      for (const [b, c] of bins) {
        const opacity = Math.min(1, 0.3 + c * 0.25)
        mk('rect', { x: x0 + b * 2, y: cy - 5, width: 1.6, height: 10, class: 'm-ink', 'fill-opacity': opacity }, svg)
      }
      for (const [from, to, verdict] of lane.flagged) {
        const w = Math.max(3, x(to) - x(from))
        mk('rect', { x: x(from), y: cy + 7, width: w, height: 3, rx: 1.5, class: `m-${verdict}` }, svg)
      }
      mk(
        'rect',
        { x: x0, y: y0 - 3, width: x1 - x0, height: rowH, class: 'hit', tabindex: 0, 'data-tip': lane.tip },
        svg
      )
    })
  }

  // Gaps between one user's consecutive danmaku; guides mark multiples of the send tick Rinnegan fitted.
  function histogram(host) {
    const gaps = data.gaps[host.dataset.gaps]
    const W = host.clientWidth
    if (!gaps || !W) return
    const H = 96
    const top = 16
    const axisY = 72
    const x0 = 4
    const x1 = W - 4
    const step = (x1 - x0) / gaps.counts.length
    const x = s => x0 + (s / gaps.max) * (x1 - x0)
    const peak = Math.max(1, ...gaps.counts)
    const y = c => axisY - (c / peak) * (axisY - top)
    const digits = gaps.bin < 0.5 ? 2 : gaps.bin < 1 ? 1 : 0
    const svg = canvas(host, W, H)
    if (gaps.tick) {
      for (let k = 1; k * gaps.tick < gaps.max; k++) {
        const gx = x(k * gaps.tick)
        mk('line', { x1: gx, x2: gx, y1: top - 8, y2: axisY, class: 'guide' }, svg)
      }
    }
    gaps.counts.forEach((c, i) => {
      if (!c) return
      const lo = i * gaps.bin
      const tip = `${lo.toFixed(digits)}–${(lo + gaps.bin).toFixed(digits)} 秒 · ${c} 个间隔`
      const g = mk('g', { tabindex: 0, 'data-tip': tip }, svg)
      mk('rect', { x: x0 + i * step, y: top - 8, width: step, height: axisY - top + 8, class: 'hit' }, g)
      mk('path', { d: roundTop(x0 + i * step + 0.5, y(c), Math.max(1, step - 1), axisY - y(c)), class: 'm-bar' }, g)
    })
    mk('line', { x1: x0, x2: x1, y1: axisY, y2: axisY, class: 'axis' }, svg)
    const every = gaps.max <= 20 ? 5 : gaps.max <= 30 ? 10 : gaps.max <= 60 ? 15 : 30
    for (let v = 0; v <= gaps.max; v += every) {
      text(svg, x(v), axisY + 16, `${v} 秒`, 'tx', v === 0 ? 'start' : v === gaps.max ? 'end' : 'middle')
    }
    const pi = gaps.counts.indexOf(peak)
    const px = Math.min(x1 - 10, Math.max(x0 + 10, x0 + (pi + 0.5) * step))
    text(svg, px, y(peak) - 5, String(peak), 'tx ink', 'middle')
  }

  const render = () => {
    for (const host of document.querySelectorAll('[data-period]')) timeline(host)
    for (const host of document.querySelectorAll('[data-gaps]')) histogram(host)
  }
  render()
  let lastWidth = innerWidth
  let timer = 0
  addEventListener('resize', () => {
    if (innerWidth === lastWidth) return
    lastWidth = innerWidth
    clearTimeout(timer)
    timer = setTimeout(render, 120)
  })

  const tip = document.getElementById('tip')
  if (!tip) return
  const show = (target, cx, cy) => {
    tip.textContent = target.getAttribute('data-tip')
    tip.hidden = false
    const r = tip.getBoundingClientRect()
    let left = cx + 12
    let top = cy - r.height - 10
    if (left + r.width > innerWidth - 8) left = cx - r.width - 12
    if (left < 8) left = 8
    if (top < 8) top = cy + 16
    tip.style.left = `${left}px`
    tip.style.top = `${top}px`
  }
  const hide = () => {
    tip.hidden = true
  }
  const target = e => (e.target instanceof Element ? e.target.closest('[data-tip]') : null)
  document.addEventListener('pointerover', e => {
    const t = target(e)
    if (t) show(t, e.clientX, e.clientY)
    else if (e.pointerType === 'mouse') hide()
  })
  document.addEventListener('pointerdown', e => {
    const t = target(e)
    if (t) show(t, e.clientX, e.clientY)
    else hide()
  })
  document.addEventListener('focusin', e => {
    const t = target(e)
    if (!t) return hide()
    const r = t.getBoundingClientRect()
    show(t, r.left + r.width / 2, r.top)
  })
  addEventListener('scroll', hide, { passive: true })
})()
