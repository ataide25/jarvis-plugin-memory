// renderers/MemoryRenderer.tsx
// Self-contained plugin renderer for the Memory Palace HUD panel.
// Compiled on-demand by the JARVIS server via esbuild.
// All React hooks are injected as globals via window.__JARVIS_REACT —
// do NOT import from 'react' or any relative path.

// ── Type ─────────────────────────────────────────────────────────────────────
interface HudComponentState {
  id: string;
  name: string;
  status: string;
  data: Record<string, unknown>;
  position: { x: number; y: number };
  size: { width: number; height: number };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  preference:     '#f8a',
  decision:       '#a6f',
  code:           '#4af',
  fact:           '#4a8',
  session_summary:'#fa4',
  task_result:    '#f84',
  conversation:   '#8af',
  error:          '#f44',
}

const DEFAULT_COLOR = '#5a6a7a'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MemoryRenderer({ state }: { state: HudComponentState }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const data = state.data as any
  const ready          = data?.ready       ?? false
  const total          = data?.total       ?? 0
  const collections    = (data?.collections  ?? []) as Array<{ name: string; count: number }>
  const recentTypes    = (data?.recentTypes  ?? {}) as Record<string, number>
  const recentSources  = (data?.recentSources ?? {}) as Record<string, number>
  const lastSaved      = data?.lastSaved   as string | undefined
  const searchCount    = data?.searchCount ?? 0
  const addCount       = data?.addCount    ?? 0

  // ── Donut canvas ────────────────────────────────────────────────────────────
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return

    const w = c.width
    const h = c.height
    ctx.clearRect(0, 0, w, h)

    if (total === 0) {
      ctx.fillStyle = '#3a4a5a'
      ctx.font = '9px "JetBrains Mono", monospace'
      ctx.textAlign = 'center'
      ctx.fillText('no memories yet', w / 2, h / 2)
      return
    }

    const cx = w / 2
    const cy = h / 2 - 4
    const outerR = Math.min(w, h) / 2 - 8
    const innerR = outerR * 0.55

    // Background ring
    ctx.beginPath()
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(42,58,74,0.3)'
    ctx.lineWidth = outerR - innerR
    ctx.stroke()

    // Segments
    const typeEntries = Object.entries(recentTypes).filter(([, v]) => v > 0)
    const typeTotal   = typeEntries.reduce((s, [, v]) => s + v, 0)

    if (typeTotal > 0) {
      let angle = -Math.PI / 2
      typeEntries.forEach(([type, count]) => {
        const sweep  = (count / typeTotal) * Math.PI * 2
        const color  = TYPE_COLORS[type] ?? DEFAULT_COLOR
        const radius = (outerR + innerR) / 2

        ctx.beginPath()
        ctx.arc(cx, cy, radius, angle, angle + sweep - 0.02)
        ctx.strokeStyle = color
        ctx.lineWidth   = outerR - innerR
        ctx.lineCap     = 'butt'
        ctx.stroke()

        // Glow
        ctx.save()
        ctx.shadowColor = color
        ctx.shadowBlur  = 6
        ctx.beginPath()
        ctx.arc(cx, cy, radius, angle, angle + sweep - 0.02)
        ctx.strokeStyle = color
        ctx.lineWidth   = 1
        ctx.stroke()
        ctx.restore()

        angle += sweep
      })
    }

    // Center text
    ctx.fillStyle = '#ffffff'
    ctx.font      = `bold ${total >= 1000 ? '13' : '15'}px "JetBrains Mono", monospace`
    ctx.textAlign = 'center'
    ctx.fillText(fmt(total), cx, cy + 4)
    ctx.fillStyle = '#5a6a7a'
    ctx.font      = '7px "Orbitron", monospace'
    ctx.fillText('MEMORIES', cx, cy + 16)

    // Ticks
    for (let i = 0; i < 24; i++) {
      const a  = (i / 24) * Math.PI * 2 - Math.PI / 2
      const r1 = outerR + 3
      const r2 = outerR + 6
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2)
      ctx.strokeStyle = 'rgba(68,170,255,0.12)'
      ctx.lineWidth   = 1
      ctx.stroke()
    }
  }, [total, recentTypes, collections])

  const canvasSize = 120

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '6px 8px', gap: '6px', fontFamily: '"JetBrains Mono", monospace', fontSize: '10px', color: '#8a9aaa' }}>

      {/* Status row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: ready ? '#4a8' : '#f44', boxShadow: ready ? '0 0 4px #4a8' : '0 0 4px #f44', flexShrink: 0 }} />
        <span style={{ color: ready ? '#4a8' : '#f44', fontSize: '9px', letterSpacing: '1px' }}>{ready ? 'ONLINE' : 'OFFLINE'}</span>
        <span style={{ marginLeft: 'auto', color: '#3a4a5a', fontSize: '9px' }}>chromadb</span>
      </div>

      {/* Donut + type legend — side by side */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <canvas ref={canvasRef} width={canvasSize} height={canvasSize} style={{ flexShrink: 0 }} />

        {/* Type breakdown legend */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '3px', overflow: 'hidden' }}>
          {Object.entries(recentTypes).length === 0 ? (
            <span style={{ color: '#3a4a5a', fontSize: '9px' }}>no data yet</span>
          ) : (
            Object.entries(recentTypes)
              .sort(([, a], [, b]) => (b as number) - (a as number))
              .slice(0, 7)
              .map(([type, count]) => {
                const pct   = total > 0 ? Math.round(((count as number) / total) * 100) : 0
                const color = TYPE_COLORS[type] ?? DEFAULT_COLOR
                return (
                  <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ width: '5px', height: '5px', borderRadius: '1px', background: color, flexShrink: 0 }} />
                    <span style={{ flex: 1, color: '#6a7a8a', fontSize: '9px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{type}</span>
                    <span style={{ color, fontSize: '9px', fontWeight: 'bold' }}>{fmt(count as number)}</span>
                    <span style={{ color: '#3a4a5a', fontSize: '8px', width: '26px', textAlign: 'right' }}>{pct}%</span>
                  </div>
                )
              })
          )}
        </div>
      </div>

      {/* Divider */}
      <div style={{ height: '1px', background: 'rgba(255,255,255,0.05)' }} />

      {/* Collections */}
      {collections.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <span style={{ color: '#4a5a6a', fontSize: '8px', letterSpacing: '1px' }}>COLLECTIONS</span>
          {collections.map(c => (
            <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ color: '#3a4a5a', fontSize: '8px' }}>▸</span>
              <span style={{ flex: 1, color: '#6a8a9a', fontSize: '9px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
              <span style={{ color: '#4af', fontSize: '9px' }}>{fmt(c.count)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Sources */}
      {Object.keys(recentSources).length > 0 && (
        <>
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.05)' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span style={{ color: '#4a5a6a', fontSize: '8px', letterSpacing: '1px' }}>SOURCES</span>
            {Object.entries(recentSources)
              .sort(([, a], [, b]) => (b as number) - (a as number))
              .slice(0, 4)
              .map(([source, count]) => (
                <div key={source} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ color: '#3a4a5a', fontSize: '8px' }}>▸</span>
                  <span style={{ flex: 1, color: '#6a8a9a', fontSize: '9px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{source}</span>
                  <span style={{ color: '#a6f', fontSize: '9px' }}>{count as number}</span>
                </div>
              ))}
          </div>
        </>
      )}

      {/* Divider */}
      <div style={{ height: '1px', background: 'rgba(255,255,255,0.05)' }} />

      {/* Stats bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: '10px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span style={{ color: '#4a8', fontSize: '11px', fontWeight: 'bold' }}>{addCount}</span>
            <span style={{ color: '#3a4a5a', fontSize: '7px', letterSpacing: '0.5px' }}>SAVED</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span style={{ color: '#4af', fontSize: '11px', fontWeight: 'bold' }}>{searchCount}</span>
            <span style={{ color: '#3a4a5a', fontSize: '7px', letterSpacing: '0.5px' }}>SEARCHED</span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
          <span style={{ color: '#3a4a5a', fontSize: '7px', letterSpacing: '0.5px' }}>LAST SAVE</span>
          <span style={{ color: '#5a6a7a', fontSize: '9px' }}>{relativeTime(lastSaved)}</span>
        </div>
      </div>

    </div>
  )
}

// Default export required for dynamic import() in HudRenderer
export default MemoryRenderer
