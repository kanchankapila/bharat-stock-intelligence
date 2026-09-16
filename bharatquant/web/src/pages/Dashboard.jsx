import React from 'react'
import { api } from '../lib/api'
import { Card, Stat, Spinner, ErrBox, fmtPct, fmtCr, pctColor } from '../lib/icons'
import RecoTable from '../components/RecoTable.jsx'

export default function Dashboard() {
  const { data, err, loading } = React.useMemo(() => ({ data: null, err: null, loading: true }), [])
  const [board, setBoard] = React.useState(null)
  React.useEffect(() => { api.board().then(setBoard).catch(() => {}) }, [])

  if (loading && !board) return <Spinner />
  const b = board || {}
  const nifty = b.nifty || []

  return (
    <div className="p-6 space-y-5 max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold">Market Command Center</h1>
        <p className="text-sm text-muted">Intraday · Swing · Long-term recommendations — as of {b.as_of || '—'}</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <Stat label="Universe scanned" value={b.universe} sub="NSE equities" />
        </Card>
        <Card className="p-4">
          <Stat label="Market Regime" value={b.regime} sub={`Breadth ${(b.breadth * 100).toFixed(0)}%`} />
        </Card>
        <Card className="p-4">
          <Stat label="Intraday setups" value={b.intraday?.length || 0} sub={b.intraday_day || '—'} />
        </Card>
        <Card className="p-4">
          <Stat label="Swing / Long setups" value={`${b.swing?.length || 0} / ${b.long_term?.length || 0}`} sub="Top-10 each" />
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card className="p-4">
          <h2 className="font-semibold mb-3 flex items-center gap-2">Intraday · Carry-Over Momentum</h2>
          <RecoTable rows={b.intraday || []} kind="intraday" />
        </Card>
        <Card className="p-4">
          <h2 className="font-semibold mb-3 flex items-center gap-2">Swing · 1–4 week</h2>
          <RecoTable rows={b.swing || []} kind="swing" />
        </Card>
      </div>
      <Card className="p-4">
        <h2 className="font-semibold mb-3">Long Term · Quality + Value</h2>
        <RecoTable rows={b.long_term || []} kind="long" />
      </Card>
    </div>
  )
}