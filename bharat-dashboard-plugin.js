// Bharat Stock Intelligence — Desktop Plugin
// Live ingestion dashboard, pipeline health, and quick actions
// Place at: ~/.hermes/desktop-plugins/bharat-dashboard/plugin.js

import { host, ctx, jsx, useValue, useQuery, queryClient, atom, computed } from '@hermes/plugin-sdk';
import {
  Button, Card, Badge, StatusDot, Separator, Tabs, TabList, Tab, TabPanel,
  ScrollArea, Skeleton, EmptyState, GlyphSpinner, Kbd, cn, icons, Tip, Tooltip
} from '@hermes/plugin-sdk';

// ─── State ───
const focusedSessionId = host.state.focusedSessionId;
const activeSessionId = host.state.activeSessionId;
const busy = host.state.busy;

// ─── Atoms for live data ───
const healthAtom = atom({ heartbeats: [], dlq: [], dq: [], loading: true, error: null });
const recommendationsAtom = atom({ data: [], loading: true, error: null });
const lastRefreshAtom = atom(Date.now());

// ─── Auto-refresh every 30 seconds ───
setInterval(() => {
  lastRefreshAtom.set(Date.now());
  refreshHealth();
  refreshRecommendations();
}, 30_000);

// ─── Fetch Functions ───
async function refreshHealth() {
  healthAtom.set({ ...healthAtom.get(), loading: true });
  try {
    const result = await host.request('tools/call', {
      name: 'mcp_bharat-intelligence_inspect_ingestion_health',
      arguments: {}
    });
    healthAtom.set({
      heartbeats: result.result?.heartbeats || [],
      dlq: result.result?.dlq_new_counts || [],
      dq: result.result?.data_quality_issues || [],
      loading: false,
      error: null
    });
  } catch (e) {
    healthAtom.set({ ...healthAtom.get(), loading: false, error: e.message });
  }
}

async function refreshRecommendations() {
  recommendationsAtom.set({ ...recommendationsAtom.get(), loading: true });
  try {
    const result = await host.request('tools/call', {
      name: 'mcp_bharat-intelligence_get_top_conviction_picks',
      arguments: { limit: 20, min_score: 60 }
    });
    recommendationsAtom.set({ data: result.result || [], loading: false, error: null });
  } catch (e) {
    recommendationsAtom.set({ ...recommendationsAtom.get(), loading: false, error: e.message });
  }
}

async function runFetcher(fetcherName, symbols = null) {
  try {
    const result = await host.request('tools/call', {
      name: 'mcp_bharat-intelligence_run_fetcher',
      arguments: { fetcher_name: fetcherName, symbols }
    });
    host.notify({ kind: 'success', message: `Fetcher ${fetcherName} completed` });
    refreshHealth();
  } catch (e) {
    host.notify({ kind: 'error', message: `Fetcher ${fetcherName} failed: ${e.message}` });
  }
}

async function requeueDLQ() {
  try {
    await host.request('tools/call', {
      name: 'mcp_bharat-intelligence_requeue_dlq',
      arguments: {}
    });
    host.notify({ kind: 'success', message: 'DLQ requeued' });
    refreshHealth();
  } catch (e) {
    host.notify({ kind: 'error', message: `DLQ requeue failed: ${e.message}` });
  }
}

// Initial load
refreshHealth();
refreshRecommendations();

// ─── Components ───
function HealthChip({ job }) {
  const isSuccess = job.last_status === 'success';
  const isRunning = job.last_status === 'running' || job.last_status === 'active';
  const neverRun = !job.last_run_at;
  
  return (
    jsx('div', { className: cn('flex items-center gap-2 px-2 py-1 rounded', neverRun && 'opacity-50') }, [
      jsx(StatusDot, { 
        status: neverRun ? 'unknown' : isRunning ? 'running' : isSuccess ? 'success' : 'error',
        size: 'sm'
      }),
      jsx('span', { className: 'text-xs font-mono truncate max-w-[120px]' }, job.job_name),
      neverRun ? jsx(Badge, { variant: 'outline', className: 'text-xs' }, 'never') :
      isRunning ? jsx(Badge, { variant: 'secondary', className: 'text-xs' }, 'running') :
      isSuccess ? jsx(Badge, { variant: 'success', className: 'text-xs' }, 'ok') :
      jsx(Badge, { variant: 'destructive', className: 'text-xs' }, 'failed'),
      job.last_error && jsx(Tooltip, { content: job.last_error }, [
        jsx('span', { className: 'text-xs text-red-500 cursor-help' }, '⚠')
      ])
    ])
  );
}

function DLQChip({ entry }) {
  return (
    jsx('div', { className: 'flex items-center gap-2 px-2 py-1 rounded bg-red-50 border border-red-200' }, [
      jsx(StatusDot, { status: 'error', size: 'sm' }),
      jsx('span', { className: 'text-xs font-mono' }, entry.fetcher_name),
      jsx(Badge, { variant: 'destructive', className: 'text-xs' }, entry.count),
      jsx(Button, { 
        size: 'sm', 
        variant: 'ghost', 
        onClick: () => runFetcher(entry.fetcher_name),
        className: 'h-5 px-1'
      }, 'Retry')
    ])
  );
}

function RecommendationRow({ rec }) {
  return (
    jsx('tr', { className: 'border-t border-ui-stroke-tertiary hover:bg-ui-card-hover' }, [
      jsx('td', { className: 'px-3 py-2 font-mono text-sm font-medium' }, rec.symbol),
      jsx('td', { className: 'px-3 py-2 text-sm' }, rec.recommendation_action),
      jsx('td', { className: 'px-3 py-2 text-sm' }, rec.conviction_level),
      jsx('td', { className: 'px-3 py-2 text-sm font-mono tabular-nums' }, rec.unified_score?.toFixed(1)),
      jsx('td', { className: 'px-3 py-2 text-sm font-mono tabular-nums' }, rec.target_price ? `₹${rec.target_price}` : '—'),
      jsx('td', { className: 'px-3 py-2 text-sm font-mono tabular-nums' }, rec.stop_loss ? `₹${rec.stop_loss}` : '—'),
      jsx('td', { className: 'px-3 py-2 text-xs text-muted-foreground' }, rec.generated_at?.split('T')[0])
    ])
  );
}

function QuickActions() {
  return (
    jsx(Card, { className: 'p-4' }, [
      jsx('h3', { className: 'font-semibold mb-3 flex items-center gap-2' }, [
        jsx(icons.zap, { className: 'h-4 w-4' }),
        'Quick Actions'
      ]),
      jsx('div', { className: 'grid gap-2 sm:grid-cols-2' }, [
        jsx(Button, { 
          variant: 'outline', 
          onClick: () => host.request('tools/call', { 
            name: 'mcp_bharat-intelligence_list_fetchers', 
            arguments: {} 
          }).then(r => host.notify({ kind: 'info', message: `Found ${r.result?.length || 0} fetchers` })),
          className: 'w-full justify-start'
        }, [jsx(icons.list, { className: 'h-4 w-4 mr-2' }), 'List All Fetchers']),
        jsx(Button, { 
          variant: 'outline', 
          onClick: requeueDLQ,
          className: 'w-full justify-start'
        }, [jsx(icons.refresh_cw, { className: 'h-4 w-4 mr-2' }), 'Requeue DLQ']),
        jsx(Button, { 
          variant: 'outline', 
          onClick: () => runFetcher('intraday_fetcher'),
          className: 'w-full justify-start'
        }, [jsx(icons.download, { className: 'h-4 w-4 mr-2' }), 'Run Intraday Fetcher']),
        jsx(Button, { 
          variant: 'outline', 
          onClick: () => runFetcher('nse_bhavcopy_fetcher'),
          className: 'w-full justify-start'
        }, [jsx(icons.database, { className: 'h-4 w-4 mr-2' }), 'Fetch NSE Bhavcopy']),
        jsx(Button, { 
          variant: 'outline', 
          onClick: () => host.request('tools/call', { 
            name: 'mcp_bharat-intelligence_get_fetcher_status', 
            arguments: {} 
          }),
          className: 'w-full justify-start'
        }, [jsx(icons.activity, { className: 'h-4 w-4 mr-2' }), 'Fetcher Status']),
        jsx(Button, { 
          variant: 'primary', 
          onClick: () => host.request('tools/call', { 
            name: 'mcp_bharat-intelligence_get_top_conviction_picks', 
            arguments: { limit: 10, min_score: 65 } 
          }),
          className: 'w-full justify-start'
        }, [jsx(icons.target, { className: 'h-4 w-4 mr-2' }), 'Top 10 Picks (≥65)'])
      ])
    ])
  );
}

function HealthTab() {
  const health = useValue(healthAtom);
  
  if (health.loading) {
    return jsx(Skeleton, { className: 'h-64' });
  }
  
  if (health.error) {
    return jsx(EmptyState, { 
      title: 'Failed to load health', 
      description: health.error,
      action: { label: 'Retry', onClick: refreshHealth }
    });
  }
  
  const failedJobs = health.heartbeats.filter(h => h.last_status !== 'success' && h.last_run_at);
  const neverRunJobs = health.heartbeats.filter(h => !h.last_run_at);
  
  return (
    jsx(ScrollArea, { className: 'h-[500px] p-4 space-y-4' }, [
      // Summary cards
      jsx('div', { className: 'grid gap-3 sm:grid-cols-3' }, [
        jsx(Card, { className: 'p-3' }, [
          jsx('div', { className: 'text-2xl font-bold text-green-500' }, 
            health.heartbeats.filter(h => h.last_status === 'success').length
          ),
          jsx('div', { className: 'text-xs text-muted-foreground' }, 'Jobs Healthy')
        ]),
        jsx(Card, { className: 'p-3' }, [
          jsx('div', { className: 'text-2xl font-bold text-red-500' }, failedJobs.length),
          jsx('div', { className: 'text-xs text-muted-foreground' }, 'Jobs Failed')
        ]),
        jsx(Card, { className: 'p-3' }, [
          jsx('div', { className: 'text-2xl font-bold text-orange-500' }, health.dlq.reduce((a, b) => a + (b.count || 0), 0)),
          jsx('div', { className: 'text-xs text-muted-foreground' }, 'DLQ Entries')
        ])
      ]),
      
      // Failed Jobs
      failedJobs.length > 0 && jsx(Card, { className: 'p-3 border-red-200' }, [
        jsx('h4', { className: 'font-semibold text-red-600 mb-2 flex items-center gap-2' }, [
          jsx(icons.alert_circle, { className: 'h-4 w-4' }),
          `Failed Jobs (${failedJobs.length})`
        ]),
        jsx('div', { className: 'flex flex-wrap gap-2' }, 
          failedJobs.slice(0, 10).map(j => jsx(HealthChip, { key: j.job_name, job: j }))
        ),
        failedJobs.length > 10 && jsx('span', { className: 'text-xs text-muted-foreground' }, 
          `...and ${failedJobs.length - 10} more`
        )
      ]),
      
      // DLQ
      health.dlq.length > 0 && jsx(Card, { className: 'p-3 border-red-200' }, [
        jsx('h4', { className: 'font-semibold text-red-600 mb-2 flex items-center gap-2' }, [
          jsx(icons.trash_2, { className: 'h-4 w-4' }),
          `Dead Letter Queue (${health.dlq.length} fetchers)`
        ]),
        jsx('div', { className: 'flex flex-wrap gap-2' }, 
          health.dlq.map(d => jsx(DLQChip, { key: d.fetcher_name, entry: d }))
        )
      ]),
      
      // Data Quality Issues
      health.dq.length > 0 && jsx(Card, { className: 'p-3 border-yellow-200' }, [
        jsx('h4', { className: 'font-semibold text-yellow-600 mb-2 flex items-center gap-2' }, [
          jsx(icons.alert_triangle, { className: 'h-4 w-4' }),
          `Data Quality Issues (${health.dq.length})`
        ]),
        jsx('div', { className: 'space-y-1 max-h-40 overflow-y-auto' },
          health.dq.map(d => jsx('div', { 
            key: d.check_id, 
            className: 'text-xs p-2 bg-yellow-50 rounded font-mono' 
          }, [
            jsx('div', { className: 'font-medium' }, d.check_id),
            jsx('div', { className: 'text-muted-foreground' }, d.detail?.slice(0, 100)),
            jsx('div', { className: 'text-xs text-muted-foreground' }, d.checked_at)
          ]))
        )
      ]),
      
      // All Jobs (collapsible)
      jsx(Card, { className: 'p-3' }, [
        jsx('h4', { className: 'font-semibold mb-2 flex items-center gap-2' }, [
          jsx(icons.list, { className: 'h-4 w-4' }),
          `All Job Heartbeats (${health.heartbeats.length})`
        ]),
        jsx('div', { className: 'flex flex-wrap gap-2' }, 
          health.heartbeats.map(j => jsx(HealthChip, { key: j.job_name, job: j }))
        )
      ])
    ])
  );
}

function RecommendationsTab() {
  const recs = useValue(recommendationsAtom);
  
  if (recs.loading) {
    return jsx(Skeleton, { className: 'h-64' });
  }
  
  if (recs.error) {
    return jsx(EmptyState, { 
      title: 'Failed to load recommendations', 
      description: recs.error,
      action: { label: 'Retry', onClick: refreshRecommendations }
    });
  }
  
  if (recs.data.length === 0) {
    return jsx(EmptyState, { 
      title: 'No recommendations', 
      description: 'No BUY signals above threshold',
      action: { label: 'Lower Threshold', onClick: () => host.request('tools/call', { 
        name: 'mcp_bharat-intelligence_get_top_conviction_picks', 
        arguments: { limit: 20, min_score: 50 } 
      }).then(r => recommendationsAtom.set({ ...recs, data: r.result })) }
    });
  }
  
  return (
    jsx(Card, { className: 'p-0 overflow-hidden' }, [
      jsx('div', { className: 'overflow-x-auto' }, [
        jsx('table', { className: 'w-full text-sm' }, [
          jsx('thead', { className: 'bg-ui-card sticky top-0' }, [
            jsx('tr', { className: 'border-b border-ui-stroke-secondary' }, [
              jsx('th', { className: 'px-3 py-2 text-left font-semibold' }, 'Symbol'),
              jsx('th', { className: 'px-3 py-2 text-left font-semibold' }, 'Action'),
              jsx('th', { className: 'px-3 py-2 text-left font-semibold' }, 'Conviction'),
              jsx('th', { className: 'px-3 py-2 text-right font-semibold tabular-nums' }, 'Score'),
              jsx('th', { className: 'px-3 py-2 text-right font-semibold tabular-nums' }, 'Target'),
              jsx('th', { className: 'px-3 py-2 text-right font-semibold tabular-nums' }, 'Stop'),
              jsx('th', { className: 'px-3 py-2 text-left font-semibold' }, 'Date')
            ])
          ]),
          jsx('tbody', {}, recs.data.map(r => jsx(RecommendationRow, { key: r.symbol, rec: r })))
        ])
      ]),
      jsx('div', { className: 'p-3 border-t border-ui-stroke-tertiary flex items-center justify-between text-xs text-muted-foreground' }, [
        jsx('span', {}, `${recs.data.length} recommendations`),
        jsx(Button, { 
          size: 'sm', 
          variant: 'ghost',
          onClick: refreshRecommendations
        }, [jsx(icons.refresh_cw, { className: 'h-3 w-3 mr-1' }), 'Refresh'])
      ])
    ])
  );
}

function FetchersTab() {
  const [fetchers, setFetchers] = useValue(atom([]));
  const [loading, setLoading] = useValue(atom(true));
  const [selected, setSelected] = useValue(atom(null));
  
  // Load fetchers on mount
  if (loading) {
    host.request('tools/call', { 
      name: 'mcp_bharat-intelligence_list_fetchers', 
      arguments: {} 
    }).then(r => {
      setFetchers(r.result || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }
  
  if (loading) return jsx(Skeleton, { className: 'h-64' });
  
  return (
    jsx(Card, { className: 'p-0 overflow-hidden' }, [
      jsx('div', { className: 'overflow-x-auto' }, [
        jsx('table', { className: 'w-full text-sm' }, [
          jsx('thead', { className: 'bg-ui-card sticky top-0' }, [
            jsx('tr', { className: 'border-b border-ui-stroke-secondary' }, [
              jsx('th', { className: 'px-3 py-2 text-left font-semibold' }, 'Fetcher'),
              jsx('th', { className: 'px-3 py-2 text-left font-semibold' }, 'Description'),
              jsx('th', { className: 'px-3 py-2 text-center font-semibold' }, 'Actions')
            ])
          ]),
          jsx('tbody', {}, fetchers.map(f => jsx('tr', { 
            key: f.name, 
            className: cn('border-t border-ui-stroke-tertiary hover:bg-ui-card-hover', selected === f.name && 'bg-accent/10')
          }, [
            jsx('td', { className: 'px-3 py-2 font-mono text-sm' }, f.name),
            jsx('td', { className: 'px-3 py-2 text-sm text-muted-foreground truncate max-w-md' }, f.description || '—'),
            jsx('td', { className: 'px-3 py-2 text-center' }, [
              jsx(Button, { 
                size: 'sm', 
                variant: selected === f.name ? 'primary' : 'outline',
                onClick: () => setSelected(f.name),
                className: 'mr-1'
              }, 'Select'),
              selected === f.name && jsx(Button, { 
                size: 'sm', 
                variant: 'default',
                onClick: () => runFetcher(f.name)
              }, 'Run')
            ])
          ])))
        ])
      ])
    ])
  );
}

// ─── Main Plugin Export ───
export default {
  id: 'bharat-dashboard',
  name: 'Bharat Stock Intelligence Dashboard',
  register(ctx) {
    // Main pane - bottom dock
    ctx.register({
      id: 'bharat-dashboard-pane',
      area: 'panes',
      data: { 
        placement: 'bottom', 
        title: 'Bharat Intelligence',
        dock: { pane: 'workspace', pos: 'bottom' },
        height: '400px'
      },
      render: () => jsx('div', { className: 'h-full flex flex-col' }, [
        // Header with tabs
        jsx('div', { className: 'border-b border-ui-stroke-secondary px-3 py-2' }, [
          jsx(Tabs, { defaultValue: 'health', className: 'w-full' }, [
            jsx(TabList, { className: 'grid w-full grid-cols-3' }, [
              jsx(Tab, { value: 'health' }, [jsx(icons.heart_pulse, { className: 'h-3 w-3 mr-1' }), 'Health']),
              jsx(Tab, { value: 'recs' }, [jsx(icons.target, { className: 'h-3 w-3 mr-1' }), 'Picks']),
              jsx(Tab, { value: 'fetchers' }, [jsx(icons.database, { className: 'h-3 w-3 mr-1' }), 'Fetchers'])
            ]),
            jsx(TabPanel, { value: 'health' }, jsx(HealthTab, {})),
            jsx(TabPanel, { value: 'recs' }, jsx(RecommendationsTab, {})),
            jsx(TabPanel, { value: 'fetchers' }, jsx(FetchersTab, {}))
          ])
        ]),
        // Quick actions bar at bottom
        jsx(QuickActions, {})
      ])
    });
    
    // Status bar chip - pipeline health summary
    ctx.register({
      id: 'bharat-pipeline-status',
      area: 'statusBar.right',
      order: 10,
      render: () => {
        const health = useValue(healthAtom);
        const failedCount = health.heartbeats?.filter(h => h.last_status !== 'success' && h.last_run_at).length || 0;
        const dlqCount = health.dlq?.reduce((a, b) => a + (b.count || 0), 0) || 0;
        const isDegraded = failedCount > 0 || dlqCount > 0;
        
        return jsx('div', { className: cn('flex items-center gap-1 px-2 py-1 rounded', isDegraded && 'bg-red-100') }, [
          jsx(StatusDot, { 
            status: isDegraded ? 'error' : 'success', 
            size: 'sm' 
          }),
          jsx('span', { className: 'text-xs font-mono' }, 
            isDegraded ? `⚠ ${failedCount} failed, ${dlqCount} DLQ` : 'Pipeline OK'
          ),
          jsx(Button, { 
            size: 'sm', 
            variant: 'ghost', 
            className: 'h-5 px-1 ml-1',
            onClick: () => host.navigate('/plugins/bharat-dashboard')
          }, [jsx(icons.chevron_right, { className: 'h-3 w-3' })])
        ]);
      }
    });
    
    // Command palette entries
    ctx.register({
      id: 'bharat-cmd-top-picks',
      area: 'PALETTE_AREA',
      data: {
        label: 'Bharat: Top Conviction Picks',
        description: 'Show top 10 BUY recommendations',
        action: () => host.request('tools/call', { 
          name: 'mcp_bharat-intelligence_get_top_conviction_picks', 
          arguments: { limit: 10, min_score: 60 } 
        }).then(r => host.notify({ kind: 'info', message: JSON.stringify(r.result, null, 2) }))
      }
    });
    
    ctx.register({
      id: 'bharat-cmd-run-fetcher',
      area: 'PALETTE_AREA',
      data: {
        label: 'Bharat: Run Fetcher',
        description: 'Trigger a specific fetcher by name',
        action: async () => {
          const fetcher = await host.request('tools/call', { 
            name: 'mcp_bharat-intelligence_list_fetchers', 
            arguments: {} 
          });
          // Would need a proper input dialog - simplified for now
          host.notify({ kind: 'info', message: `Available: ${fetcher.result?.map(f => f.name).join(', ')}` });
        }
      }
    });
    
    ctx.register({
      id: 'bharat-cmd-health',
      area: 'PALETTE_AREA',
      data: {
        label: 'Bharat: Ingestion Health',
        description: 'Check pipeline health and DLQ status',
        action: () => refreshHealth().then(() => {
          const h = healthAtom.get();
          host.notify({ kind: 'info', message: `Jobs: ${h.heartbeats?.length}, Failed: ${h.heartbeats?.filter(x => x.last_status !== 'success').length}, DLQ: ${h.dlq?.reduce((a,b)=>a+b.count,0)}` });
        })
      }
    });
    
    ctx.register({
      id: 'bharat-cmd-requeue-dlq',
      area: 'PALETTE_AREA',
      data: {
        label: 'Bharat: Requeue DLQ',
        description: 'Re-queue all failed DLQ entries for retry',
        action: requeueDLQ
      }
    });
  }
};