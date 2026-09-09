import React from 'react'
import {
  BarChart3, Clock, TrendingUp, Landmark, Search as SearchIcon,
  Activity, ArrowUpRight, ArrowDownRight, Minus, ChevronRight,
  Star, Shield, Zap, Target, AlertTriangle
} from 'lucide-react'

const M = { BarChart3, Clock, TrendingUp, Landmark, Search: SearchIcon,
  Activity, ArrowUpRight, ArrowDownRight, Minus, ChevronRight,
  Star, Shield, Zap, Target, AlertTriangle }

export function Icon({ name, size = 18, className = '' }) {
  const C = M[name] || Activity
  return <C size={size} className={className} />
}

export function fmtPct(v, d = 2) {
  if (v == null || Number.isNaN(v)) return '—'
  const s = (v * 100).toFixed(d)
  return `${v > 0 ? '+' : ''}${s}%`
}

export function fmtNum(v, d = 2) {
  if (v == null || Number.isNaN(v)) return '—'
  return Number(v).toLocaleString('en-IN', { maximumFractionDigits: d })
}

export function fmtCr(v) {
  if (v == null || Number.isNaN(v)) return '—'
  return `₹${(v / 1e7).toFixed(1)} Cr`
}

export function pctColor(v, invert = false) {
  if (v == null || Number.isNaN(v)) return 'text-muted'
  const s = invert ? -v : v
  return s > 0.0005 ? 'text-up' : s < -0.0005 ? 'text-down' : 'text-muted'
}

export function gradeColor(g) {
  if (g === 'A+') return 'bg-up/15 text-up border-up/30'
  if (g === 'A') return 'bg-accent/15 text-accent border-accent/30'
  if (g === 'B') return 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30'
  return 'bg-line text-muted border-line'
}

export function GradePill({ grade }) {
  return <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${gradeColor(grade)}`}>{grade || '—'}</span>
}

export function Card({ children, className = '' }) {
  return <div className={`bg-panel border border-line rounded-xl ${className}`}>{children}</div>
}

export function Stat({ label, value, sub, color }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-lg font-semibold ${color || 'text-txt'}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  )
}

export function Spinner() {
  return <div className="flex items-center justify-center py-12"><div className="w-8 h-8 border-2 border-line border-t-accent rounded-full animate-spin" /></div>
}

export function ErrBox({ msg }) {
  return <div className="flex items-center gap-2 p-3 rounded-lg bg-down/10 text-down text-sm"><AlertTriangle size={16}/>{msg}</div>
}

export function useAsync(fn, deps = []) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    setLoading(true)
    fn().then(d => { setData(d); setErr(null) }).catch(e => setErr(e.message)).finally(() => setLoading(false))
  }, deps)
  return { data, err, loading }
}