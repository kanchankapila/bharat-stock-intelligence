import React from 'react'
import { useNavigate } from 'react-router-dom'
import { fmtPct, fmtNum, GradePill, pctColor } from '../lib/icons'

export default function RecoTable({ rows, kind }) {
  const nav = useNavigate()
  if (!rows || rows.length === 0) {
    return <div className="text-center py-10 text-muted text-sm">No qualifying setups right now.</div>
  }
  const isIntra = kind === 'intraday'
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted uppercase border-b border-line">
          <tr>
            <th className="text-left py-2 px-3">#</th>
            <th className="text-left py-2 px-3">Symbol</th>
            <th className="text-right py-2 px-3">Close</th>
            <th className="text-right py-2 px-3">D-1 Ret</th>
            {isIntra && <th className="text-right py-2 px-3">Ret @10:00</th>}
            {!isIntra && <th className="text-right py-2 px-3">5d Ret</th>}
            <th className="text-right py-2 px-3">Score</th>
            <th className="text-center py-2 px-3">Grade</th>
            <th className="text-right py-2 px-3">Stop</th>
            <th className="text-right py-2 px-3">Target</th>
            <th className="text-right py-2 px-3">R:R</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.symbol}
              className="border-b border-line hover:bg-panel2 cursor-pointer transition-colors"
              onClick={() => nav(`/stock/${r.symbol}`)}>
              <td className="py-2.5 px-3 text-muted">{isIntra ? r.co_rank || i + 1 : r.bq_rank || i + 1}</td>
              <td className="py-2.5 px-3 font-medium">{r.symbol}</td>
              <td className="py-2.5 px-3 text-right">{fmtNum(r.close)}</td>
              <td className={`py-2.5 px-3 text-right ${pctColor(r.d1_ret)}`}>{fmtPct(r.d1_ret)}</td>
              {isIntra && <td className={`py-2.5 px-3 text-right ${pctColor(r.ret_from_open)}`}>{fmtPct(r.ret_from_open)}</td>}
              {!isIntra && <td className={`py-2.5 px-3 text-right ${pctColor(r.ret_5d)}`}>{fmtPct(r.ret_5d)}</td>}
              <td className="py-2.5 px-3 text-right font-semibold">{r.final ?? r.score ?? '—'}</td>
              <td className="py-2.5 px-3 text-center"><GradePill grade={r.grade} /></td>
              <td className="py-2.5 px-3 text-right">{r.stop ? fmtNum(r.stop) : '—'}</td>
              <td className="py-2.5 px-3 text-right">{r.target ? fmtNum(r.target) : '—'}</td>
              <td className="py-2.5 px-3 text-right">{r.risk_reward ? r.risk_reward.toFixed(2) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}