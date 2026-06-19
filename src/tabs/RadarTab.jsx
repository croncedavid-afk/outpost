import React, { useState, useEffect, useMemo, useRef } from 'react';
import { sb } from '../supabase.js';

const DAY_MS = 86400000;

// PM status, mirroring the platform's getPMStatus (interval defaults 90d / 45k mi).
function pmStatus(unit, iv) {
  const days = unit.last_pm_date ? Math.floor((Date.now() - new Date(unit.last_pm_date)) / DAY_MS) : 999;
  const miles = (unit.mileage != null && unit.last_pm_mileage != null) ? unit.mileage - unit.last_pm_mileage : 0;
  const iDays = iv.interval_days || 90, iMiles = iv.interval_miles || 45000;
  const dPct = iDays > 0 ? days / iDays : 0, mPct = iMiles > 0 ? miles / iMiles : 0;
  const nextDays = iDays - days, nextMiles = iMiles - miles;
  if (dPct >= 1 || mPct >= 1) return { status: 'overdue', daysOverdue: Math.max(0, -nextDays), milesOverdue: Math.max(0, -nextMiles) };
  if (dPct >= 0.85 || mPct >= 0.85) return { status: 'due_soon', daysToDue: Math.max(0, nextDays), milesToDue: Math.max(0, nextMiles) };
  return { status: 'current', daysToDue: Math.max(0, nextDays) };
}

// PM currency color thresholds — platform standard (matches The Bridge cPm).
const cPmColor = (v) => v == null ? 'var(--muted)' : v >= 90 ? 'var(--green)' : v >= 80 ? 'var(--amber)' : 'var(--accent)';


// ── AI PM FORECAST (Outpost) ───────────────────────────────────
// Self-paced truck loader, platform standard, paced to predict_pm avg latency.
function ForecastLoader() {
  const [p, setP] = useState(0);
  const avgMs = useRef(9000);
  const raf = useRef(null);
  useEffect(() => {
    let alive = true;
    (async () => { try { const { data } = await sb.rpc('ai_avg_latency', { p_feature: 'predict_pm' }); if (alive && data && data > 800) avgMs.current = Math.min(data, 25000); } catch {} })();
    const t0 = performance.now();
    const tick = (now) => { const frac = (now - t0) / avgMs.current;
      const eased = frac < 1 ? 0.88 * (1 - Math.pow(1 - Math.min(frac, 1), 3)) : 0.88 + 0.09 * (1 - Math.exp(-(frac - 1) * 0.7));
      setP(Math.min(eased, 0.97)); raf.current = requestAnimationFrame(tick); };
    raf.current = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(raf.current); };
  }, []);
  const pct = Math.round(p * 100);
  const ix = 120, iy = 32, iw = 178, ih = 62; const fillW = iw * p;
  return (
    <div style={{ padding: '8px 2px' }}>
      <svg viewBox="0 0 360 130" width="100%" height="100" style={{ maxWidth: 360 }} role="img" aria-label={`Forecasting, about ${pct} percent`}>
        <style>{`@keyframes opwheel{to{transform:rotate(360deg)}}`}</style>
        <line x1="6" y1="112" x2="354" y2="112" stroke="var(--border2)" strokeWidth="2" strokeDasharray="6 7"><animate attributeName="stroke-dashoffset" from="0" to="-26" dur="0.7s" repeatCount="indefinite" /></line>
        <rect x="114" y="26" width="190" height="74" rx="6" fill="var(--surface3, #fff)" stroke="var(--border2)" strokeWidth="2" />
        <clipPath id="opClip"><rect x={ix} y={iy} width={iw} height={ih} rx="3" /></clipPath>
        <g clipPath="url(#opClip)">
          <rect x={ix} y={iy} width={fillW} height={ih} fill="var(--accent)" opacity="0.9" />
          {p < 1 && <rect x={ix + Math.max(0, fillW - 14)} y={iy} width="14" height={ih} fill="var(--accent2,#ff7a1a)" opacity="0.55" />}
        </g>
        <path d="M40 100 L40 64 Q40 58 46 58 L74 58 L86 38 Q88 34 94 34 L108 34 L108 100 Z" fill="var(--surface2, #fff)" stroke="var(--border2)" strokeWidth="2" />
        <path d="M78 56 L88 40 Q89 38 92 38 L102 38 L102 56 Z" fill="var(--blue-dim)" stroke="var(--border2)" strokeWidth="1.5" />
        {[60, 100, 170, 250, 286].map((cx, i) => (
          <g key={i} transform={`translate(${cx} 100)`}>
            <circle r="13" fill="var(--nav-bg,#0a0a0a)" stroke="var(--border2)" strokeWidth="2" />
            <g style={{ animation: 'opwheel 0.6s linear infinite', transformOrigin: 'center' }}>
              <line x1="-8" y1="0" x2="8" y2="0" stroke="var(--muted2)" strokeWidth="2" />
              <line x1="0" y1="-8" x2="0" y2="8" stroke="var(--muted2)" strokeWidth="2" />
            </g>
            <circle r="3" fill="var(--muted)" />
          </g>
        ))}
      </svg>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>Forecasting likely PM needs… <span style={{ fontWeight: 700, color: 'var(--text)' }}>{pct}%</span></div>
    </div>
  );
}

const STD_INTERVALS = { '090': 25000, '017': 90000, '013': 50000, '016': 50000, '043': 120000, '045': 100000, '024': 150000, '002': 25000 };
const SEV_STYLE = (sev) => sev === 'due'
  ? { bg: 'var(--red-dim)', fg: 'var(--accent)' }
  : sev === 'watch'
  ? { bg: 'var(--amber-dim)', fg: 'var(--amber)' }
  : { bg: 'var(--surface2)', fg: 'var(--muted)' };
const CONF_LABEL = { high: 'HIGH', med: 'MED', low: 'LOW' };

function ForecastPanel({ ctx, overdue, dueSoon }) {
  const { user, loc } = ctx;
  const [busy, setBusy] = useState(false);
  const [forecast, setForecast] = useState([]);
  const [ranAt, setRanAt] = useState(null);
  const [status, setStatus] = useState('');
  const [note, setNote] = useState('');

  // 15-unit set: all overdue first (priority), then fill with due-soon
  const selected = useMemo(() => {
    const od = overdue.slice(0, 15);
    return [...od, ...dueSoon.slice(0, Math.max(0, 15 - od.length))];
  }, [overdue, dueSoon]);
  const moreThanCap = (overdue.length + dueSoon.length) > 15;

  const fingerprint = useMemo(() => selected.map(u => `${u.id}:${Math.round((Number(u.mileage) || 0) / 1000)}:${u.pm?.status || ''}`).sort().join('|'), [selected]);

  // load saved forecast for this terminal
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!user?.company_id || !loc?.id) return;
      const { data } = await sb.from('pm_ai_forecasts').select('forecast,ran_at').eq('company_id', user.company_id).eq('location_id', loc.id).maybeSingle();
      if (!alive) return;
      if (data) { setForecast(data.forecast || []); setRanAt(data.ran_at || null); }
    })();
    return () => { alive = false; };
  }, [user?.company_id, loc?.id]);

  async function buildPayload() {
    const out = [];
    for (const u of selected) {
      let components = [];
      try {
        const { data: heads } = await sb.from('ro_headers').select('id,odometer,opened_date').eq('unit_number', u.unit_number).not('odometer', 'is', null).order('opened_date', { ascending: false }).range(0, 4999);
        const ids = (heads || []).map(h => h.id);
        const odoBy = {}; (heads || []).forEach(h => { odoBy[h.id] = h.odometer; });
        let jobs = [];
        for (let i = 0; i < ids.length; i += 300) {
          const { data: jr } = await sb.from('ro_jobs').select('ro_id,component_code').in('ro_id', ids.slice(i, i + 300)).not('component_code', 'is', null).range(0, 9999);
          jobs = jobs.concat(jr || []);
        }
        const bySys = {};
        jobs.forEach(j => { const sys = (j.component_code || '').slice(0, 3); if (!sys) return; const odo = odoBy[j.ro_id]; if (odo == null) return; (bySys[sys] = bySys[sys] || []).push(odo); });
        components = Object.entries(bySys).map(([sys, odos]) => {
          odos.sort((a, b) => b - a);
          const last = odos[0]; const cur = Number(u.mileage) || last;
          let derived = null;
          if (odos.length >= 2) { const g = []; for (let i = 0; i < odos.length - 1; i++) g.push(odos[i] - odos[i + 1]); derived = Math.round(g.reduce((a, b) => a + b, 0) / g.length); }
          return { code: sys, last_done_miles: last, miles_since: Math.max(0, cur - last), times_done: odos.length, derived_interval: derived, standard_interval: STD_INTERVALS[sys] || null };
        }).filter(x => x.derived_interval || x.standard_interval).slice(0, 12);
      } catch {}
      out.push({ unit_number: u.unit_number, unit_type: u.unit_type, year: u.year, make: u.make, model: u.model, engine_model: u.engine_model || null, current_miles: Number(u.mileage) || null, status: u.pm?.status, days_overdue: u.pm?.status === 'overdue' ? (u.pm?.daysOverdue ?? null) : null, components });
    }
    return out;
  }

  async function run() {
    if (busy || !selected.length) return;
    setBusy(true); setNote(''); setStatus('');
    try {
      const units = await buildPayload();
      const meta = { company_name: user.company_name || null, user_id: user.id || null, user_name: user.name || user.email || null, user_role: user.role || null };
      const res = await fetch('/api/predict-pm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company_id: user.company_id, location_id: loc.id, units, fingerprint, meta }) });
      const data = await res.json();
      if (data.error === 'not_configured') { setNote("AI forecast isn't configured yet — add the Anthropic API key in Netlify and redeploy."); setBusy(false); return; }
      if (data.error) { setNote('Forecast failed: ' + (data.detail || data.error)); setBusy(false); return; }
      setStatus(data.status || '');
      if (data.status === 'limit_reached') { setNote(data.message || ''); if (data.forecast) setForecast(data.forecast); if (data.ran_at) setRanAt(data.ran_at); }
      else {
        setForecast(data.forecast || []); setRanAt(data.ran_at || null);
        if (data.status === 'reused_daily') setNote('Already forecasted today — showing the latest. Fresh run available tomorrow.');
        else if (data.status === 'reused_unchanged') setNote('No unit data changed since the last forecast — showing the saved result (no run used).');
      }
    } catch (e) { setNote('Forecast failed: ' + String(e)); }
    setBusy(false);
  }

  const fmtWhen = (t) => { if (!t) return ''; try { return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch { return ''; } };
  const byUnit = {}; forecast.forEach(f => { byUnit[f.unit_number] = f; });
  if (!selected.length) return null;

  return (
    <div className="card" style={{ border: '1px solid var(--blue)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', marginBottom: 18 }}>
      <div style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16 }}>✨</span>
          <span style={{ fontWeight: 600, fontSize: 13 }}>AI forecast — {selected.length} unit{selected.length !== 1 ? 's' : ''} due or overdue</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          {ranAt && <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--muted2)' }}>updated {fmtWhen(ranAt)}</span>}
          <button className="btn btn-sm" onClick={run} disabled={busy}>{busy ? 'Forecasting…' : (forecast.length ? '↻ Refresh' : '✨ Forecast PM needs')}</button>
        </div>
      </div>
      {busy && <div style={{ padding: 8 }}><ForecastLoader /></div>}
      {note && !busy && (
        <div style={{ padding: '10px 14px', fontSize: 12.5, color: status === 'limit_reached' ? 'var(--amber)' : 'var(--muted)', background: status === 'limit_reached' ? 'var(--amber-dim)' : 'transparent', borderBottom: forecast.length ? '1px solid var(--border)' : 'none', lineHeight: 1.5 }}>{note}</div>
      )}
      {!busy && !forecast.length && !note && (
        <div style={{ padding: 16, fontSize: 13, color: 'var(--muted)' }}>Tap <b>Forecast PM needs</b> to predict likely service for these units.{moreThanCap && ' Showing the 15 most urgent (overdue first).'}</div>
      )}
      {!busy && forecast.length > 0 && selected.map((u) => {
        const f = byUnit[u.unit_number]; const od = u.pm?.status === 'overdue';
        return (
          <div key={u.id} style={{ padding: '11px 14px', borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: f && f.items && f.items.length ? 6 : 0 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: od ? 'var(--accent)' : 'var(--amber)' }} />
              <span style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 13 }}>{u.unit_number}</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{od ? 'overdue' : 'due soon'}{u.mileage ? ' · ' + u.mileage.toLocaleString() + ' mi' : ''}{f && f.headline ? ' · ' + f.headline : ''}</span>
            </div>
            {f && f.items && f.items.length > 0 && (
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', paddingLeft: 18 }}>
                {f.items.map((it, i) => { const s = SEV_STYLE(it.severity); return (
                  <span key={i} style={{ fontSize: 11, background: s.bg, color: s.fg, padding: '3px 8px', borderRadius: 6 }}>{it.label}{it.detail ? ' — ' + it.detail : ''}{it.confidence ? ' · ' + (CONF_LABEL[it.confidence] || it.confidence) : ''}</span>
                ); })}
              </div>
            )}
            {f && f.note && <div style={{ fontSize: 11, color: 'var(--muted)', paddingLeft: 18, marginTop: 6, fontStyle: 'italic' }}>{f.note}</div>}
          </div>
        );
      })}
    </div>
  );
}

export default function RadarTab({ ctx }) {
  const { loc, fullAccess, setActiveTab } = ctx;
  const [units, setUnits] = useState([]);
  const [intervals, setIntervals] = useState([]);
  const [vendorOut, setVendorOut] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const [uRes, iRes, vRes] = await Promise.all([
        sb.from('units').select('*').eq('location_id', loc.id).eq('status', 'active').order('unit_number').range(0, 49999),
        sb.from('pm_intervals').select('*'),
        sb.from('vendor_ro_headers').select('id').eq('company_id', ctx.user.company_id).is('closed_date', null).range(0, 9999),
      ]);
      if (!alive) return;
      setUnits(uRes.data || []);
      setIntervals(iRes.data || []);
      setVendorOut(vRes.data || []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [loc.id, ctx.user.company_id]);

  const withStatus = useMemo(() => units.map(u => {
    const iv = intervals.find(i => i.unit_subtype === (u.unit_subtype || u.unit_type)) || {};
    return { ...u, pm: pmStatus(u, iv) };
  }), [units, intervals]);

  const overdue = withStatus.filter(u => u.pm.status === 'overdue');
  const dueSoon = withStatus.filter(u => u.pm.status === 'due_soon');
  const current = withStatus.filter(u => u.pm.status === 'current');
  const dueList = [...overdue, ...dueSoon];
  // PM currency = share of units current on their required PM (platform standard, matches The Bridge)
  const pmCurrencyPct = units.length ? Math.round(100 * current.length / units.length) : null;

  if (loading) return <div className="loading">Loading radar…</div>;

  const Metric = ({ label, value, sub, color }) => (
    <div style={{ background: 'var(--surface2)', borderRadius: 'var(--radius-md)', padding: 12 }}>
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{label}</div>
      <div style={{ fontSize: 21, fontWeight: 600, color: color || 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--muted2)', marginTop: 2 }}>{sub}</div>}
    </div>
  );

  return (
    <div style={{ padding: 16 }}>
      {/* location highlights — PM currency, platform-standard */}
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)', textTransform: 'uppercase', marginBottom: 8 }}>{loc.name} · at a glance</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 10, marginBottom: 18 }}>
        <Metric label="Fleet active" value={units.length} sub="units" />
        <Metric label="PM currency" value={pmCurrencyPct == null ? '—' : pmCurrencyPct + '%'} sub={`${current.length} of ${units.length} current`} color={cPmColor(pmCurrencyPct)} />
        <Metric label="PM due soon" value={dueSoon.length} sub="approaching" color="var(--amber)" />
        <Metric label="PM overdue" value={overdue.length} sub="act now" color="var(--accent)" />
        <Metric label="Out at vendor" value={vendorOut.length} sub="in service" />
      </div>

      {fullAccess && <ForecastPanel ctx={ctx} overdue={overdue} dueSoon={dueSoon} />}

      {/* PM radar — auto-generated due list, send when ready */}
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)', textTransform: 'uppercase', marginBottom: 8 }}>
        PM radar · {dueList.length} unit{dueList.length !== 1 ? 's' : ''} due or overdue{!fullAccess && ' · managed by your shop'}
      </div>
      {dueList.length === 0 ? (
        <div className="card" style={{ padding: 24, fontSize: 13, color: 'var(--muted)' }}>Nothing due right now — the fleet is current.</div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          {dueList.map((u, idx) => {
            const od = u.pm.status === 'overdue';
            const detail = od
              ? `${u.pm.daysOverdue || 0}d overdue${u.mileage ? ' · ' + u.mileage.toLocaleString() + ' mi' : ''}`
              : `due in ${u.pm.daysToDue || 0}d${u.mileage ? ' · ' + u.mileage.toLocaleString() + ' mi' : ''}`;
            return (
              <div key={u.id} style={{ padding: '12px 14px', borderTop: idx ? '1px solid var(--border)' : 'none', display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: od ? 'var(--accent)' : 'var(--amber)', flexShrink: 0 }} />
                <span style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 14, minWidth: 64 }}>{u.unit_number}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)', flex: 1 }}>{detail}</span>
                {fullAccess && (
                  <button className="btn btn-sm" onClick={() => setActiveTab('send_out')}>Send out</button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
