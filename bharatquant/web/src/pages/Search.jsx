import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { Search as SearchIcon } from 'lucide-react'

export default function Search() {
  const [q, setQ] = useState('')
  const [res, setRes] = useState([])
  const [done, setDone] = useState(false)
  const nav = useNavigate()

  const run = async (e) => {
    e?.preventDefault()
    if (!q.trim()) return
    setDone(false)
    try { setRes((await api.search(q)).results || []) } catch { setRes([]) }
    setDone(true)
  }

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-2xl font-bold mb-1">Stock Search</h1>
      <p className="text-sm text-muted mb-5">Search by symbol or company name.</p>
      <form onSubmit={run} className="flex gap-2 mb-6">
        <div className="relative flex-1">
          <SearchIcon size={16} className="absolute left-3 top-3 text-muted" />
          <input value={q} onChange={e => setQ(e.target.value)}
            placeholder="e.g. RELIANCE, HDFCBANK, Titan..."
            className="w-full bg-panel border border-line rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:border-accent" />
        </div>
        <button className="px-5 py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90">Search</button>
      </form>
      {res.length > 0 ? (
        <div className="bg-panel border border-line rounded-xl overflow-hidden">
          {res.map(r => (
            <div key={r.symbol} onClick={() => nav(`/stock/${r.symbol}`)}
              className="flex items-center justify-between px-4 py-3 border-b border-line last:border-0 hover:bg-panel2 cursor-pointer">
              <div>
                <div className="font-medium">{r.symbol}</div>
                <div className="text-xs text-muted">{r.name}</div>
              </div>
              <span className="text-xs text-muted">{r.sector}</span>
            </div>
          ))}
        </div>
      ) : done ? <p className="text-sm text-muted">No matches.</p> : null}
    </div>
  )
}