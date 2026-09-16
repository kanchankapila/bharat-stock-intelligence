import React from 'react'
import { api } from '../lib/api'
import { Card, Spinner, ErrBox } from '../lib/icons'
import RecoTable from '../components/RecoTable.jsx'

function Page({ kind, title, subtitle, emptyNote }) {
  const [board, setBoard] = React.useState(null)
  const [err, setErr] = React.useState(null)
  React.useEffect(() => {
    api.board().then(setBoard).catch(e => setErr(e.message))
  }, [])
  if (err) return <div className="p-6"><ErrBox msg={err} /></div>
  if (!board) return <Spinner />
  const rows = kind === 'intraday' ? board.intraday : kind === 'swing' ? board.swing : board.long_term
  return (
    <div className="p-6 space-y-4 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        <p className="text-sm text-muted">{subtitle}</p>
      </div>
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-muted">As of {board.as_of} · {rows?.length || 0} setups</span>
        </div>
        <RecoTable rows={rows || []} kind={kind} />
        {(!rows || rows.length === 0) && <p className="text-center text-sm text-muted py-6">{emptyNote}</p>}
      </Card>
    </div>
  )
}

export function Intraday() {
  return <Page kind="intraday" title="Intraday · Carry-Over Momentum (CoMo-10)"
    subtitle="Yesterday's winners that are NOT over-extended this morning. Entry ~10:00 IST, time-exit 14:45–15:15."
    emptyNote="No qualifying intraday setups (market closed or no eligible candidates)." />
}
export function Swing() {
  return <Page kind="swing" title="Swing · 1–4 Week Momentum"
    subtitle="Mean-reverted momentum + trend + value composite. Stop = entry − 2.5×ATR14, Target = entry + 4×ATR14."
    emptyNote="No qualifying swing setups." />
}
export function LongTerm() {
  return <Page kind="long" title="Long Term · Quality + Value (3m–1y)"
    subtitle="Trend structure, fundamentals (ROE/margins/Piotroski/D/E), and 3y PE/PB percentile."
    emptyNote="No qualifying long-term setups." />
}

export default Intraday