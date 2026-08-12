import { memo, useEffect, useMemo, useState } from 'react'
import { connectContainerStats, disconnectContainerStats, reconcileContainerStats, useContainerStats } from './containerStatsStore'

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('token') || '')
  const [password, setPassword] = useState('')
  const [authMode, setAuthMode] = useState(null) // null while loading, then 'password' | 'none'
  const [loading, setLoading] = useState(false)
  const [containers, setContainers] = useState([])
  const [agg, setAgg] = useState(null)
  const [aggHist, setAggHist] = useState({ cpu: [], mem: [], rx: [], tx: [], r: [], w: [] })
  const [broadcast, setBroadcast] = useState({ action: '', at: 0 })
  const [globalPhase, setGlobalPhase] = useState('') // '', 'start', 'restart', 'stop'
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => { if (token) localStorage.setItem('token', token) }, [token])

  useEffect(() => {
    fetch('/api/auth-mode').then(r => r.json()).then(d => {
      setAuthMode(d.mode)
      if (d.mode === 'none' && !token) setToken('no-auth')
    }).catch(() => setAuthMode('password'))
  }, [])

  const sortedContainers = useMemo(() => (
    [...containers].sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }))
  ), [containers])

  const login = async () => {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })
    if (res.ok) { const d = await res.json(); setToken(d.token); window.location.reload() } else { alert('Invalid password') }
  }
  const logout = () => { setToken(''); localStorage.removeItem('token'); window.location.reload() }

  const loadContainers = async () => {
    setError(''); setLoading(true)
    try {
      const headers = new Headers({ 'Content-Type': 'application/json' })
      if (token) headers.set('Authorization', `Bearer ${token}`)
      const r = await fetch('/api/containers', { headers })
      if (r.status === 401) { localStorage.removeItem('token'); window.location.reload(); return }
      if (!r.ok) throw new Error(await r.text().catch(()=>`HTTP ${r.status}`))
      const d = await r.json()
      setContainers(d.items || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally { setLoading(false) }
  }
  useEffect(() => { if (token) void loadContainers() }, [token])
  useEffect(() => {
    if (!token) return
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = new URL('/ws/containers/stream', window.location.origin)
    url.searchParams.set('token', token)
    const ws = new WebSocket(`${proto}://${window.location.host}${url.pathname}${url.search}`)
    ws.onmessage = (ev) => { try { const d = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); if (Array.isArray(d.items)) setContainers(d.items) } catch {} }
    ws.onerror = () => {}
    return () => { try { ws.close() } catch {} }
  }, [token])

  useEffect(() => {
    if (!token) return
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = new URL('/ws/containers/all/stats', window.location.origin)
    url.searchParams.set('token', token)
    const ws = new WebSocket(`${proto}://${window.location.host}${url.pathname}${url.search}`)
    ws.onmessage = (ev) => {
      try {
        const d = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data))
        setAgg(d)
        setAggHist(prev => ({
          cpu: [...prev.cpu.slice(-39), d.cpuPercent || 0],
          mem: [...prev.mem.slice(-39), d.memUsage || 0],
          rx:  [...prev.rx.slice(-39),  d.rxRate || 0],
          tx:  [...prev.tx.slice(-39),  d.txRate || 0],
          r:   [...prev.r.slice(-39),   d.ioReadRate || 0],
          w:   [...prev.w.slice(-39),   d.ioWriteRate || 0],
        }))
      } catch {}
    }
    ws.onerror = () => {}
    return () => { try { ws.close() } catch {} }
  }, [token])

  useEffect(() => {
    if (!token) {
      disconnectContainerStats()
      return
    }
    connectContainerStats(token)
    return () => disconnectContainerStats()
  }, [token])

  useEffect(() => {
    reconcileContainerStats(containers.map((container) => container.id))
  }, [containers])

  if (authMode === null) {
    return null
  }

  if (!token) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1 className="login-title">DockerDash</h1>
          <label className="login-label">Password</label>
          <div className="login-form">
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoFocus placeholder="Enter password" className="login-input" />
            <button type="button" onClick={login} className="btn btn-primary">Login</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-title">DockerDash</div>
        <div>
          {authMode !== 'none' && (
            <button onClick={logout} className="btn btn-outline">Logout</button>
          )}
        </div>
      </header>
      <main className="app-main">
        {error && <div className="error-banner">{error}</div>}
        {loading && !error && <div className="loading-banner">Loading containers…</div>}
        <div className="grid">
          <AllInline token={token} agg={agg} hist={aggHist} containers={containers}
            onBroadcast={(action)=> setBroadcast({ action, at: Date.now() })}
            onPhaseChange={(type, active) => setGlobalPhase(active ? type : '')}
          />
          {sortedContainers.map(c => (
            <ContainerInline key={c.id} container={c} token={token} broadcast={broadcast} globalPhase={globalPhase} />
          ))}
          {containers.length === 0 && !error && (
            <div className="empty-state">No containers found.</div>
          )}
        </div>
      </main>
    </div>
  )
}

const ContainerInline = memo(function ContainerInline({ container, token, broadcast, globalPhase }) {
  const stats = useContainerStats(container.id)

  const uptime = useMemo(() => {
    const now = Date.now()
    const isRunning = container.state === 'running'
    const ref = isRunning ? container.startedAt : container.finishedAt
    if (!ref) return undefined
    const t = new Date(ref).getTime()
    if (Number.isNaN(t)) return undefined
    const diff = Math.max(0, Math.floor((now - t) / 1000))
    const h = Math.floor(diff / 3600), m = Math.floor((diff % 3600) / 60), s = diff % 60
    const parts = []; if (h) parts.push(`${h}h`); if (m || h) parts.push(`${m}m`); parts.push(`${s}s`)
    return parts.join(' ')
  }, [stats, container.startedAt, container.finishedAt, container.state])
  const [busy, setBusy] = useState('')
  const [phase, setPhase] = useState('idle') // 'idle'|'starting'|'restarting'|'stopping'
  useEffect(() => {
    if (!broadcast || !broadcast.action) return
    const lowerName = (container.name || '').toLowerCase()
    const lowerImage = (container.image || '').toLowerCase()
    if (lowerName.includes('dockerdash') || lowerImage.includes('dockerdash')) return
    setMsg(broadcast.action.charAt(0).toUpperCase()+broadcast.action.slice(1)+' issued')
    if (broadcast.action === 'start') setPhase('starting')
    if (broadcast.action === 'restart') setPhase('restarting')
    if (broadcast.action === 'stop') setPhase('stopping')
    setTimeout(()=> setMsg(''), 1500)
    setTimeout(()=> setPhase('idle'), 3000)
  }, [broadcast])
  const [msg, setMsg] = useState('')

  const action = async (type) => {
    if (busy) return
    setBusy(type)
    if (type==='start') setPhase('starting')
    if (type==='restart') setPhase('restarting')
    if (type==='stop') setPhase('stopping')
    try {
      const headers = new Headers()
      if (token) headers.set('Authorization', `Bearer ${token}`)
      const r = await fetch(`/api/containers/${container.id}/${type}`, { method: 'POST', headers })
      if (!r.ok) throw new Error(await r.text().catch(()=> 'request failed'))
      setMsg(type==='pull' ? 'Rebuild started' : type.charAt(0).toUpperCase()+type.slice(1)+' OK')
      setTimeout(()=> setMsg(''), 2000)
    } catch (e) {
      setMsg(type==='pull' ? 'Rebuild failed (local image or no registry?)' : 'Action failed')
      setTimeout(()=> setMsg(''), 2500)
    } finally {
      setBusy('')
      setTimeout(()=> setPhase('idle'), 3000)
    }
  }

  const cpuSeries = stats.map(s => s.cpuPercent || 0)
  const memSeries = stats.map(s => s.memUsage || 0)
  const rxSeries = stats.map(s => (s.rxBytes || 0))
  const txSeries = stats.map(s => (s.txBytes || 0))
  const ioReadSeries = stats.map(s => (s.ioRead || 0))
  const ioWriteSeries = stats.map(s => (s.ioWrite || 0))

  const isRunning = container.state === 'running'
  const globalDisableStart = globalPhase === 'start'
  const globalDisableRestart = globalPhase === 'restart'
  const globalDisableStop = globalPhase === 'stop'
  const killMode = phase === 'starting' || phase === 'restarting'
  const lowerName = (container.name || '').toLowerCase()
  const lowerImage = (container.image || '').toLowerCase()
  const disableRebuild = lowerName.includes('dockerdash') || lowerImage.includes('dockerdash')

  return (
    <div className="card">
      <div className="card-title">{container.name}</div>
      <div className="card-subtitle">
        {container.image}
        {(container.hostPorts && container.hostPorts.length>0) && (
          <>
            {' '}|{' '}Ports: {container.hostPorts.join(', ')}
          </>
        )}
      </div>
      <div className="card-status-row">
        <span className={isRunning ? 'status status-running' : 'status status-other'}>{container.state}</span>
        {uptime && <span className="card-meta">• {container.state==='running'?'up':'down'} {uptime}</span>}
      </div>
      <div className="actions-row">
        <button onClick={() => action('start')} disabled={busy!=='' || isRunning || globalDisableStart || phase==='restarting' || phase==='stopping'} className="btn btn-primary">Start</button>
        <button onClick={() => action('restart')} disabled={busy!=='' || !isRunning || globalDisableRestart || phase==='starting' || phase==='stopping'} className="btn btn-primary">Restart</button>
        <button onClick={() => action(killMode ? 'kill' : 'stop')} disabled={busy!=='' || (globalDisableStop) || (phase==='stopping') || (!isRunning && !killMode)} className="btn btn-danger">{killMode ? 'Kill' : 'Stop'}</button>
        {/* Rebuild removed */}
        {(busy || msg) && <span className="status-text">{busy? (busy==='start'?'Starting…':busy==='restart'?'Restarting…':busy==='stop'?'Stopping…':busy==='pull'?'Rebuilding…':'Working…') : msg}</span>}
      </div>
      <div className="stats-grid">
        <StatSpark title="CPU" values={cpuSeries} format={(v)=>`${v.toFixed(1)}%`} />
        <StatSpark title="Memory Used" values={memSeries} format={(v)=>formatBytes(v)} />
        {(() => { return (
          <StatSpark title={`Networking Down`} values={stats.map(s=> (s.rxRate||0))} format={(v)=> `${formatBytes(v)}/s`} />
        )})()}
        {(() => { return (
          <StatSpark title={`Networking Up`} values={stats.map(s=> (s.txRate||0))} format={(v)=> `${formatBytes(v)}/s`} />
        )})()}
        <StatSpark title={`Disk Read`} values={stats.map(s=> (s.ioReadRate||0))} format={(v)=> `${formatBytes(v)}/s`} />
        <StatSpark title={`Disk Write`} values={stats.map(s=> (s.ioWriteRate||0))} format={(v)=> `${formatBytes(v)}/s`} />
      </div>
    </div>
  )
})

function AllInline({ token, agg, hist, containers, onBroadcast, onPhaseChange }) {
  const uptime = useMemo(() => {
    if (!agg || typeof agg.uptimeSec !== 'number') return undefined
    const diff = Math.max(0, Math.floor(agg.uptimeSec))
    const h = Math.floor(diff / 3600), m = Math.floor((diff % 3600) / 60), s = diff % 60
    const parts = []; if (h) parts.push(`${h}h`); if (m || h) parts.push(`${m}m`); parts.push(`${s}s`)
    return parts.join(' ')
  }, [agg])
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const actionAll = async (type) => {
    if (busy) return
    setBusy(type)
    onPhaseChange && onPhaseChange(type, true)
    try {
      const r = await fetch(`/api/containers`, { headers: { Authorization: `Bearer ${token}` } })
      const d = await r.json();
      const items = d.items || []
      await Promise.all(items.map(c => {
        const lowerName = (c.name || '').toLowerCase();
        const lowerImage = (c.image || '').toLowerCase();
        if (lowerName.includes('dockerdash') || lowerImage.includes('dockerdash')) return Promise.resolve();
        return fetch(`/api/containers/${c.id}/${type}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(()=>{})
      }))
      setMsg(type.charAt(0).toUpperCase()+type.slice(1)+' issued for all')
      setTimeout(()=> setMsg(''), 2000)
      onBroadcast && onBroadcast(type)
    } catch { setMsg('Action failed'); setTimeout(()=> setMsg(''), 2500) } finally { setBusy(''); onPhaseChange && onPhaseChange(type, false) }
  }
  const cpuSeries = (hist && hist.cpu && hist.cpu.length) ? hist.cpu : [agg ? (agg.cpuPercent||0) : 0]
  const memSeries = (hist && hist.mem && hist.mem.length) ? hist.mem : [agg ? (agg.memUsage||0) : 0]
  const rxSeries = (hist && hist.rx && hist.rx.length) ? hist.rx : [agg ? (agg.rxRate||0) : 0]
  const txSeries = (hist && hist.tx && hist.tx.length) ? hist.tx : [agg ? (agg.txRate||0) : 0]
  const ioReadSeries = (hist && hist.r && hist.r.length) ? hist.r : [agg ? (agg.ioReadRate||0) : 0]
  const ioWriteSeries = (hist && hist.w && hist.w.length) ? hist.w : [agg ? (agg.ioWriteRate||0) : 0]
  return (
    <div className="card">
      <div className="card-title">All Dockers</div>
      <div className="card-subtitle">docker:{agg && agg.engineVersion ? agg.engineVersion : 'unknown'}</div>
      <div className="card-status-row">
        <span className="status status-running">system running</span>
        {uptime && <span className="card-meta">• {uptime}</span>}
      </div>
      <div className="actions-row">
        <button onClick={() => actionAll('start')} disabled={busy!=='' || (containers.every(c => c.state==='running'))} className="btn btn-primary">Start</button>
        <button onClick={() => actionAll('restart')} disabled={busy!==''} className="btn btn-primary">Restart</button>
        <button onClick={() => actionAll('stop')} disabled={busy!=='' || (containers.every(c => c.state!=='running'))} className="btn btn-danger">Stop</button>
        {busy && <span className="status-text">{busy==='start'?'Starting…':busy==='restart'?'Restarting…':'Stopping…'}</span>}
        {!busy && msg && <span className="status-text">{msg}</span>}
      </div>
      <div className="stats-grid">
        <StatSpark title="CPU" values={cpuSeries} format={(v)=>`${v.toFixed(1)}%`} />
        <StatSpark title="Memory Used" values={memSeries} format={(v)=>formatBytes(v)} />
        {(() => { return (
          <StatSpark title="Networking Down" values={rxSeries} format={(v)=>`${formatBytes(v)}/s`} />
        )})()}
        {(() => { return (
          <StatSpark title="Networking Up" values={txSeries} format={(v)=>`${formatBytes(v)}/s`} />
        )})()}
        {(() => { return (
          <StatSpark title="Disk Read" values={ioReadSeries} format={(v)=>`${formatBytes(v)}/s`} />
        )})()}
        {(() => { return (
          <StatSpark title="Disk Write" values={ioWriteSeries} format={(v)=>`${formatBytes(v)}/s`} />
        )})()}
      </div>
    </div>
  )
}

function ContainerModal({ container, onClose }) {
  const [tab, setTab] = useState('terminal')
  const [inspectData, setInspectData] = useState(null)
  const [actionBusy, setActionBusy] = useState('')
  const [stats, setStats] = useState(null)

  const doAction = async (id, type) => {
    setActionBusy(type)
    try { await api(`/api/containers/${id}/${type}`, { method: 'POST' }) } catch (e) { alert((e && e.message) || 'Error') } finally { setActionBusy('') }
  }

  const TabButton = ({ id, label }) => (
    <button onClick={() => setTab(id)} className={tab === id ? 'tab-button tab-button-active' : 'tab-button'}>{label}</button>
  )

  return (
    <div onClick={onClose} className="modal-overlay">
      <div onClick={e => e.stopPropagation()} className="modal">
        <div className="modal-header">
          <div className="modal-title">{container.name}</div>
          <button onClick={onClose} aria-label="Close" className="btn btn-outline">✕</button>
        </div>
        <div className="modal-body">
          <aside className="modal-sidebar">
            <div className="modal-sidebar-list">
              <TabButton id='terminal' label='Terminal' />
              <TabButton id='console' label='Console' />
              <TabButton id='files' label='File Manager' />
              <TabButton id='stats' label='Stats' />
              <TabButton id='network' label='Networking' />
            </div>
          </aside>
          <section className="modal-content">
            <div className="modal-content-body">
              {tab === 'terminal' && (<TerminalTab containerId={container.id} />)}
              {tab === 'console' && (<LogsTab containerId={container.id} />)}
              {tab === 'files' && (<FilesTab containerId={container.id} />)}
              {tab === 'stats' && (<StatsTab containerId={container.id} stats={stats} setStats={setStats} />)}
              {tab === 'network' && (<NetworkTab containerId={container.id} inspectData={inspectData} setInspectData={setInspectData} />)}
            </div>
            <div className="modal-actions">
              <button className="btn btn-primary" disabled={!!actionBusy} onClick={() => doAction(container.id, 'start')}>{actionBusy==='start'?'Starting…':'Start'}</button>
              <button className="btn btn-primary" disabled={!!actionBusy} onClick={() => doAction(container.id, 'restart')}>{actionBusy==='restart'?'Restarting…':'Restart'}</button>
              <button className="btn btn-danger" disabled={!!actionBusy} onClick={() => doAction(container.id, 'stop')}>{actionBusy==='stop'?'Stopping…':'Stop'}</button>
              <button className="btn btn-secondary" disabled={!!actionBusy} onClick={() => doAction(container.id, 'pull')}>{actionBusy==='pull'?'Rebuilding…':'Rebuild'}</button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function StatSpark({ title, values, format }) {
  const last = values.length ? values[values.length - 1] : 0
  // Simple inline sparkline using divs
  const max = Math.max(1, ...values)
  const points = values.slice(-40)
  return (
    <div className="stat-card">
      <div className="stat-header">
        <div className="stat-title">{title}</div>
        <div className="stat-value">{format(last || 0)}</div>
      </div>
      <div className="sparkline">
        <div className="sparkline-bars">
          {points.map((v, i) => {
            const h = Math.max(1, Math.round((v / max) * 36))
            return <div key={i} className="sparkline-bar" style={{ height: h }} />
          })}
        </div>
      </div>
    </div>
  )
}

function formatBytes(num) {
  const n = Number(num) || 0
  if (n < 1024) return `${n|0} B`
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`
  if (n < 1024*1024*1024) return `${(n/1024/1024).toFixed(1)} MB`
  return `${(n/1024/1024/1024).toFixed(2)} GB`
}
