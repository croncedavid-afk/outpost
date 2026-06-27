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

// Shop-Command-style typeahead: shows first results on focus, narrows as you type,
// mobile-safe (onMouseDown + preventDefault so the tap registers before blur).
function Typeahead({ placeholder, fetcher, display, meta, onPick, autoFocus }) {
  const [value, setValue] = useState('');
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    function onDown(e) { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown); };
  }, []);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const t = setTimeout(async () => {
      setLoading(true);
      try { const data = await fetcher(value.trim()); if (alive) setRows(data || []); }
      finally { if (alive) setLoading(false); }
    }, 200);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, open]);

  async function openList() {
    setOpen(true); setLoading(true);
    try { const data = await fetcher(value.trim()); setRows(data || []); }
    finally { setLoading(false); }
  }

  return (
    <div style={{ position: 'relative' }} ref={boxRef}>
      <input
        className="input"
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onFocus={openList}
        onChange={(e) => { setValue(e.target.value); setOpen(true); }}
      />
      {open && (
        <div className="card" style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, marginTop: 4, maxHeight: 260, overflowY: 'auto' }}>
          {loading && <div style={{ padding: '9px 12px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)' }}>Searching…</div>}
          {!loading && rows.length === 0 && <div style={{ padding: '9px 12px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)' }}>No matches</div>}
          {!loading && rows.map((r) => (
            <div
              key={r.id}
              onMouseDown={(e) => { e.preventDefault(); setOpen(false); onPick(r); }}
              style={{ padding: '9px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600 }}>{display(r)}</span>
              {meta && <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted2)', whiteSpace: 'nowrap' }}>{meta(r)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function UnitsOutTab({ ctx }) {
  const { loc, openRO, openUnit } = ctx;
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  // search mode: null (just the Search button) | 'choose' (two buttons) | 'unit' | 'ro'
  const [searchMode, setSearchMode] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
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
  }, [loc.id, ctx.user.company_id, ctx.roOverlayOpen]);

  // fetchers (scoped to this terminal + company), mirror Shop Command behavior
  async function fetchUnits(term) {
    let q = sb.from('units').select('id,unit_number,unit_type,year,make,model,mileage')
      .eq('location_id', loc.id).order('unit_number').limit(10);
    if (ctx.user.company_id) q = q.eq('company_id', ctx.user.company_id);
    if (term) q = q.ilike('unit_number', term + '%');
    const { data } = await q;
    return data || [];
  }
  async function fetchROs(term) {
    // open outside ROs at this terminal; match on RO number or unit number
    let q = sb.from('outside_ros')
      .select('id,ro_number,unit_number,vendor_name,current_notes,date_sent,estimated_cost,final_cost,status,odometer')
      .eq('location_id', loc.id).order('ro_number', { ascending: false }).limit(10);
    if (ctx.user.company_id) q = q.eq('company_id', ctx.user.company_id);
    if (term) q = q.or(`ro_number.ilike.%${term}%,unit_number.ilike.${term}%`);
    const { data } = await q;
    return data || [];
  }

  function resetSearch() { setSearchMode(null); }

  function fmtMiles(n) { return Number(n).toLocaleString(); }

  if (loading) return <div className="loading">Loading units out…</div>;

  return (
    <div style={{ padding: 16 }}>
      {/* search control: button -> two buttons -> typeahead */}
      <div style={{ marginBottom: 14, maxWidth: 420 }}>
        {searchMode === null && (
          <button className="btn btn-sm" onClick={() => setSearchMode('choose')}>🔍 Search</button>
        )}
        {searchMode === 'choose' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)' }}>Search for:</span>
            <button className="btn btn-sm btn-primary" onClick={() => setSearchMode('unit')}>Unit #</button>
            <button className="btn btn-sm btn-primary" onClick={() => setSearchMode('ro')}>Repair Order</button>
            <button className="btn btn-sm" onClick={resetSearch} style={{ marginLeft: 'auto' }}>✕</button>
          </div>
        )}
        {searchMode === 'unit' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>Unit file</span>
              <button className="btn btn-sm" onClick={resetSearch} style={{ marginLeft: 'auto' }}>✕</button>
            </div>
            <Typeahead
              placeholder="Type unit number"
              autoFocus
              fetcher={fetchUnits}
              display={(u) => `#${u.unit_number}`}
              meta={(u) => [u.year, u.make, u.model].filter(Boolean).join(' ') || (u.mileage != null ? fmtMiles(u.mileage) + ' mi' : '—')}
              onPick={(u) => { resetSearch(); openUnit(u.id); }}
            />
          </div>
        )}
        {searchMode === 'ro' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>Repair order</span>
              <button className="btn btn-sm" onClick={resetSearch} style={{ marginLeft: 'auto' }}>✕</button>
            </div>
            <Typeahead
              placeholder="Type RO number or unit number"
              autoFocus
              fetcher={fetchROs}
              display={(r) => r.ro_number}
              meta={(r) => `#${r.unit_number}${r.vendor_name ? ' · ' + r.vendor_name : ''}`}
              onPick={(r) => { resetSearch(); openRO(r); }}
            />
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
