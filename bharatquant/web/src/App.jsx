import React, { useEffect, useState } from 'react'
import { Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { api } from './lib/api'
import Dashboard from './pages/Dashboard.jsx'
import Intraday from './pages/Intraday.jsx'
import Swing from './pages/Swing.jsx'
import LongTerm from './pages/LongTerm.jsx'
import Stock from './pages/Stock.jsx'
import Search from './pages/Search.jsx'
import { BarChart3, Clock, TrendingUp, Landmark, Search as SearchIcon, Activity } from 'lucide-react'

const NAV = [
  { to: '/', label: 'Dashboard', icon: BarChart3, end: true },
  { to: '/intraday', label: 'Intraday', icon: Clock },
  { to: '/swing', label: 'Swing', icon: TrendingUp },
  { to: '/long-term', label: 'Long Term', icon: Landmark },
  { to: '/search', label: 'Search', icon: SearchIcon }
]

export default function App() {
  const [health, setHealth] = useState(null)
  useEffect(() => { api.health().then(setHealth).catch(() => setHealth({ status: 'down' })) }, [])

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="w-56 shrink-0 bg-panel border-r border-line flex flex-col">
        <div className="px-5 py-4 border-b border-line flex items-center gap-2">
          <Activity className="text-accent" size={22} />
          <div>
            <div className="font-semibold leading-tight">BharatQuant</div>
            <div className="text-[10px] text-muted leading-tight">Desk · NSE/BSE</div>
          </div>
        </div>
        <nav className="flex-1 py-3 space-y-0.5">
          {NAV.map(n => (
            <NavLink key={n.to} to={n.to} end={n.end}
              className={({ isActive }) =>
                `flex items-center gap-3 px-5 py-2.5 text-sm transition-colors ${
                  isActive ? 'bg-accent/10 text-accent border-r-2 border-accent' : 'text-muted hover:text-txt hover:bg-panel2'
                }`}>
              <n.icon size={18} /><span>{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="px-5 py-3 border-t border-line text-xs text-muted">
          <div>Regime: <span className="text-txt">{health?.regime || '—'}</span></div>
          <div>Session: <span className={health?.session === 'OPEN' ? 'text-up' : 'text-muted'}>{health?.session || '—'}</span></div>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/intraday" element={<Intraday />} />
          <Route path="/swing" element={<Swing />} />
          <Route path="/long-term" element={<LongTerm />} />
          <Route path="/stock/:symbol" element={<Stock />} />
          <Route path="/search" element={<Search />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}