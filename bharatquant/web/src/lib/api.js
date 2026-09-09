const BASE = '/api'

async function get(path) {
  const r = await fetch(BASE + path)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export const api = {
  board: () => get('/board'),
  stock: (s) => get(`/stock/${encodeURIComponent(s)}`),
  search: (q) => get(`/search?q=${encodeURIComponent(q)}`),
  market: () => get('/market'),
  delivery: () => get('/delivery'),
  health: () => get('/health')
}