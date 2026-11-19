// Organic randomizer: makes every stored schedule look human.
// - Run sizes are random, never repeated, never a flat "100, 100, 100".
// - Gaps between runs are irregular (short bursts, long pauses).
// - Total quantity and the delivery window are always preserved.

export interface OrganicRun {
  scheduled_at: string
  quantity_to_send: number
  base_quantity?: number
  variance_applied?: number
  peak_multiplier?: number
  [key: string]: unknown
}

export interface OrganicOptions {
  total: number
  providerMin: number
  /** Keep exactly this many runs (user picked a run count). */
  exactRuns?: boolean
  /** Window start (ms). Defaults to the first run's time. */
  startMs?: number
  /** Window end (ms). Defaults to the last run's time. */
  endMs?: number
  random?: () => number
}

function gaussian(rand: () => number) {
  const u = Math.max(1e-9, rand())
  const v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export function randomQuantities(
  total: number,
  count: number,
  min: number,
  rand: () => number = Math.random,
): number[] {
  const n = Math.max(1, count)
  if (n === 1) return [total]
  const floor = Math.max(1, Math.min(min, Math.floor(total / n)))
  const spare = total - floor * n
  const weights = Array.from({ length: n }, () => {
    let w = Math.exp(gaussian(rand) * 0.55)
    const r = rand()
    if (r < 0.12) w *= 1.8 + rand() * 0.9 // spike
    else if (r < 0.27) w *= 0.3 + rand() * 0.3 // dip
    return w
  })
  const sum = weights.reduce((a, b) => a + b, 0)
  const qty = weights.map((w) => floor + Math.floor((w / sum) * spare))
  let rest = total - qty.reduce((a, b) => a + b, 0)
  while (rest > 0) {
    qty[Math.floor(rand() * n)]++
    rest--
  }

  // Remove repeats and "too round" values by moving single units between
  // runs. Total is unchanged and nobody drops below the floor.
  const isBad = (i: number) =>
    qty.some((q, j) => j !== i && q === qty[i]) || (qty[i] % 10 === 0 && n > 1 && rand() < 0.8)
  for (let pass = 0; pass < 4000; pass++) {
    const bad = qty.findIndex((_, i) => isBad(i))
    if (bad < 0) break
    const donors = qty
      .map((q, j) => ({ q, j }))
      .filter(({ q, j }) => j !== bad && q > floor)
    if (donors.length === 0) break
    const d = donors[Math.floor(rand() * donors.length)].j
    if (rand() < 0.5 && qty[bad] > floor) {
      qty[bad]--
      qty[d]++
    } else {
      qty[bad]++
      qty[d]--
    }
  }
  return qty
}

export function randomTimes(
  count: number,
  startMs: number,
  endMs: number,
  rand: () => number = Math.random,
): number[] {
  if (count <= 1) return [startMs]
  const span = Math.max(0, endMs - startMs)
  const gaps = Array.from({ length: count - 1 }, () => {
    let g = -Math.log(Math.max(1e-6, rand())) // exponential: many short, some long
    g = Math.min(3.2, Math.max(0.25, g))
    if (rand() < 0.12) g *= 1.8 + rand() // occasional long pause
    return g
  })
  const gSum = gaps.reduce((a, b) => a + b, 0)
  const minGap = Math.min(4 * 60 * 1000, span / (count - 1) / 2)
  const free = Math.max(0, span - minGap * (count - 1))
  const times = [startMs]
  let t = startMs
  for (const g of gaps) {
    t += minGap + (g / gSum) * free
    times.push(t)
  }
  // Random seconds so times never land on neat minute marks.
  return times.map((x, i) => {
    const jitter = i === 0 || i === times.length - 1 ? 0 : (rand() * 2 - 1) * Math.min(90_000, minGap / 3)
    return Math.round(x + jitter + rand() * 59_000)
  })
}

export function organicizeSchedule<T extends OrganicRun>(runs: T[], opts: OrganicOptions): T[] {
  const rand = opts.random ?? Math.random
  const total = Math.max(0, Math.round(opts.total))
  if (runs.length === 0 || total <= 0) return runs
  const min = Math.max(1, opts.providerMin)

  const sorted = [...runs].sort(
    (a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime(),
  )
  const firstMs = new Date(sorted[0].scheduled_at).getTime()
  const lastMs = new Date(sorted[sorted.length - 1].scheduled_at).getTime()
  const startMs = opts.startMs ?? firstMs
  const endMs = Math.max(startMs, opts.endMs ?? lastMs)

  // Leave room above the minimum so sizes can actually vary.
  const roomyMax = Math.max(1, Math.floor(total / (min * 1.5)))
  const hardMax = Math.max(1, Math.floor(total / min))
  let n: number
  if (opts.exactRuns) {
    n = Math.min(runs.length, hardMax)
  } else {
    n = Math.min(runs.length, roomyMax)
    if (n > 3) n += Math.floor(rand() * 3) - 1 // small random run-count drift
    n = Math.max(1, Math.min(n, roomyMax))
  }

  const qty = randomQuantities(total, n, min, rand)
  const times = randomTimes(n, startMs, endMs, rand)
  const avg = total / n
  const template = sorted[0]

  return qty.map((q, i) => {
    const src = sorted[Math.min(sorted.length - 1, Math.floor((i * sorted.length) / n))] ?? template
    return {
      ...src,
      run_number: i + 1,
      scheduled_at: new Date(times[i]).toISOString(),
      quantity_to_send: q,
      base_quantity: q,
      variance_applied: Math.round((q / avg - 1) * 100),
    }
  })
}
