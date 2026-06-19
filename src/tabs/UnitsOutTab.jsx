import React, { useState, useEffect, useRef } from 'react';
import { sb } from '../supabase.js';

const HR_MS = 3600000;
function dwell(sent) {
  if (!sent) return { label: '—', tone: 'muted' };
  const ms = Date.now() - new Date(sent).getTime();
  const d = Math.floor(ms / (24 * HR_MS));
  const h = Math.floor((ms % (24 * HR_MS)) / HR_MS);
  const label = d > 0 ? `out ${d}d ${h}h` : `out ${h}h`;
  const tone = d >= 3 ? 'red' : d >= 1 ? 'amber' : 'green';
  return { label, tone };
}

export default function UnitsOutTab({ ctx }) {
  const { loc, openRO, openUnit } = ctx;
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  // unit search (open any unit file at this terminal)
  const [uq, setUq] = useState('');
  const [uMatches, setUMatches] = useState([]);
  const [uOpen, setUOpen] = useState(false);
  const [uLoading, setULoading] = useState(false);
  const searchRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      // OPEN outside ROs at this terminal — outside_ros, not closed/reviewed yet.
      // location_id is text (e.g. 'beaumont'); scope to this terminal directly.
      let q = sb.from('outside_ros')
        .select('id,ro_number,unit_number,vendor_name,current_notes,date_sent,estimated_cost,final_cost,status,odometer')
        .eq('location_id', loc.id)
        .not('status', 'in', '(reviewed,closed,denied)')
        .order('date_sent', { ascending: true })
        .range(0, 9999);
      if (ctx.user.company_id) q = q.eq('company_id', ctx.user.company_id);
      const { data } = await q;
      if (!alive) return;
      setRows(data || []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [loc.id, ctx.user.company_id]);

  // close search dropdown on outside tap
  useEffect(() => {
    function onDown(e) { if (searchRef.current && !searchRef.current.contains(e.target)) setUOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown); };
  }, []);

  async function loadUnits(term) {
    setULoading(true);
    try {
      let query = sb.from('units')
        .select('id,unit_number,unit_type,year,make,model,mileage')
        .eq('location_id', loc.id)
        .order('unit_number')
        .limit(8);
      if (ctx.user.company_id) query = query.eq('company_id', ctx.user.company_id);
      if (term) query = query.ilike('unit_number', term + '%');
      const { data } = await query;
      setUMatches(data || []);
    } finally { setULoading(false); }
  }
  useEffect(() => {
    if (!uOpen) return;
    let alive = true;
    const t = setTimeout(() => { if (alive) loadUnits(uq.trim()); }, 200);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uq, uOpen, loc.id, ctx.user.company_id]);

  function fmtMiles(n) { return Number(n).toLocaleString(); }

  if (loading) return <div className="loading">Loading units out…</div>;

  return (
    <div style={{ padding: 16 }}>
      {/* unit file search */}
      <div style={{ position: 'relative', marginBottom: 14, maxWidth: 360 }} ref={searchRef}>
        <input
          className="input"
          placeholder="🔍 Open a unit file…"
          value={uq}
          onFocus={() => { setUOpen(true); loadUnits(uq.trim()); }}
          onChange={e => { setUq(e.target.value); setUOpen(true); }}
        />
        {uOpen && (
          <div className="card" style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, marginTop: 4, maxHeight: 260, overflowY: 'auto' }}>
            {uLoading && <div style={{ padding: '9px 12px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)' }}>Searching…</div>}
            {!uLoading && uMatches.length === 0 && <div style={{ padding: '9px 12px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)' }}>No units at this terminal</div>}
            {!uLoading && uMatches.map(u => (
              <div
                key={u.id}
                onMouseDown={(e) => { e.preventDefault(); setUOpen(false); setUq(''); openUnit(u.id); }}
                style={{ padding: '9px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)', fontSize: 13, display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                <span>
                  <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{u.unit_number}</span>
                  <span style={{ color: 'var(--muted)', marginLeft: 8 }}>{[u.year, u.make, u.model].filter(Boolean).join(' ') || u.unit_type}</span>
                </span>
                {u.mileage != null && <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted2)', whiteSpace: 'nowrap' }}>{fmtMiles(u.mileage)} mi</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)', textTransform: 'uppercase', marginBottom: 8 }}>
        Units out · {rows.length} at a vendor
      </div>
      {rows.length === 0 ? (
        <div className="card" style={{ padding: 24, fontSize: 13, color: 'var(--muted)' }}>No units are out for outside repair right now.</div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          {rows.map((r, idx) => {
            const dw = dwell(r.date_sent);
            const cls = dw.tone === 'red' ? 'badge-red' : dw.tone === 'amber' ? 'badge-amber' : 'badge-green';
            const cost = r.final_cost ?? r.estimated_cost;
            return (
              <div
                key={r.id}
                onClick={() => openRO(r)}
                style={{ padding: '12px 14px', borderTop: idx ? '1px solid var(--border)' : 'none', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface2, rgba(0,0,0,0.02))'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 90 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 14 }}>{r.unit_number}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted2)' }}>{r.ro_number}</span>
                </span>
                <span style={{ fontSize: 12, color: 'var(--muted)', flex: 1 }}>
                  {r.vendor_name || 'Vendor'}{r.current_notes ? ' · ' + r.current_notes.slice(0, 48) : ''}
                  {cost ? ' · $' + Math.round(cost).toLocaleString() : ''}
                </span>
                <span className={'badge ' + cls}>{dw.label}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted2)' }}>›</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
