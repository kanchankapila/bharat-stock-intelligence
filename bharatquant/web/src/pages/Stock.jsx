import React, { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { createChart } from 'lightweight-charts'
import { api } from '../lib/api'
import { Card, Stat, Spinner, ErrBox, fmtPct, fmtNum, fmtCr, pctColor, GradePill } from '../lib/icons'

export default function Stock() {
  const { symbol } = useParams()
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const chartRef = useRef(null)
  const seriesRef = useRef({})

  useEffect(() => {
    setData(null); setErr(null)
    api.stock(symbol).then(d => { if (d.found) setData(d); else setErr(`${symbol} not found`) })
      .catch(e => setErr(e.message))
  }, [symbol])

  // candlestick chart
  useEffect(() => {
    if (!data || !chartRef.current) return
    const el = chartRef.current
    el.innerHTML = ''
    const chart = createChart(el, {
      width: el.clientWidth, height: 380,
      layout: { background: { color: '#111827' }, textColor: '#94a3b8' },
      grid: { vertLines: { color: '#1f2a3a' }, horzLines: { color: '#1f2a3a' } },
      timeScale: { borderColor: '#1f2a3a' }, rightPriceScale: { borderColor: '#1f2a3a' }
    })
    const candle = chart.addCandlestickSeries({ upColor: '#22c55e', downColor: '#ef4444', borderVisible: false })
    const vol = chart.addHistogramSeries({ color: '#3b82f6', priceFormat: { type: 'volume' }, priceScaleId: '' })
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.7, bottom: 0 } })
    const rows = (data.series || []).map(r => ({ time: r.date, open: r.open, high: r.high, low: r.low, close: r.close }))
    candle.setData(rows)
    vol.setData((data.series || []).map(r => ({ time: r.date, value: r.volume, color: r.close >= r.open ? '#22c55e55' : '#ef444455' })))
    seriesRef.current = { chart, candle }
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }))
    ro.observe(el)
    return () => { ro.disconnect(); chart.remove() }
  }, [data])

  if (err) return <div className="p-6"><ErrBox msg={err} /></div>
  if (!data) return <Spinner />

  const p = data.profile || {}
  const f = data.fundamentals || {}
  const dayChg = data.prev_close ? (data.price / data.prev_close - 1) : null

  return (
    <div className="p-6 space-y-5 max-w-7xl">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">{symbol} <span className="text-base text-muted font-normal">{p.name}</span></h1>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted">
            <span>{p.sector}</span><span>·</span><span>{p.industry}</span>
            {p.fno_eligible ? <><span>·</span><span className="text-accent">F&O</span></> : null}
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold">₹{fmtNum(data.price)}</div>
          <div className={`text-sm ${pctColor(dayChg)}`}>{fmtPct(dayChg)} today</div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card className="p-3"><Stat label="1d / 5d / 21d" value={`${fmtPct(data.ret_1d)} / ${fmtPct(data.ret_5d)}`} sub={fmtPct(data.ret_21d) + ' (21d)'} /></Card>
        <Card className="p-3"><Stat label="Tier" value={data.tier} sub="Liquidity" /></Card>
        <Card className="p-3"><Stat label="ATR(14)" value={fmtNum(data.atr14)} sub="Stop/Target basis" /></Card>
        <Card className="p-3"><Stat label="Mkt Cap" value={fmtCr(p.market_cap)} sub={p.is_nifty50 ? 'NIFTY 50' : p.is_nifty200 ? 'NIFTY 200' : ''} /></Card>
        <Card className="p-3"><Stat label="ROE / D/E" value={`${fmtNum(f.return_on_equity)}%`} sub={fmtNum(f.debt_to_equity) + ' D/E'} /></Card>
      </div>

      <Card className="p-3">
        <div ref={chartRef} className="w-full" style={{ height: 380 }} />
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card className="p-4">
          <h3 className="font-semibold mb-2">Fundamentals</h3>
          <div className="grid grid-cols-2 gap-y-2 text-sm">
            <div className="text-muted">Piotroski F</div><div>{f.piotroski_f_score ?? '—'}</div>
            <div className="text-muted">Op. Margin</div><div>{fmtPct(f.operating_margins)}</div>
            <div className="text-muted">Rev Growth</div><div>{fmtPct(f.revenue_growth)}</div>
            <div className="text-muted">EPS Growth</div><div>{fmtPct(f.earnings_growth)}</div>
            <div className="text-muted">Pledge</div><div>{fmtPct(f.pledge_pct)}</div>
          </div>
        </Card>
        <Card className="p-4">
          <h3 className="font-semibold mb-2">Recent News</h3>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {(data.news || []).slice(0, 8).map(n => (
              <div key={n.id} className="text-sm border-b border-line pb-2">
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] px-1 rounded ${n.sentiment === 'Positive' ? 'bg-up/15 text-up' : n.sentiment === 'Negative' ? 'bg-down/15 text-down' : 'bg-line text-muted'}`}>{n.sentiment}</span>
                  <span className="text-muted text-xs">{n.source}</span>
                </div>
                <div className="text-txt">{n.title}</div>
              </div>
            ))}
            {(!data.news || data.news.length === 0) && <div className="text-sm text-muted">No recent news.</div>}
          </div>
        </Card>
      </div>
    </div>
  )
}