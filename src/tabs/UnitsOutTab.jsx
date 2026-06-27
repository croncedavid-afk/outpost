import React, { useState, useEffect, useRef, useMemo } from 'react';
import { sb } from '../supabase.js';

const HR_MS = 3600000;
function dwell(sent) {
  if (!sent) return { label: '—', tone: 'muted', ms: 0 };
  const ms = Date.now() - new Date(sent).getTime();
  const d = Math.floor(ms / (24 * HR_MS));
  const h = Math.floor((ms % (24 * HR_MS)) / HR_MS);
  const label = d > 0 ? `out ${d}d ${h}h` : `out ${h}h`;
  const tone = d >= 3 ? 'red' : d >= 1 ? 'amber' : 'green';
  return { label, tone, ms };
}
function fmtUpdate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const days = Math.floor((Date.now() - d) / (24 * HR_MS));
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (days <= 0) return `today · ${date}`;
  if (days === 1) return `1d ago · ${date}`;
  return `${days}d ago · ${date}`;
}

// Shop-Command-style typeahead (unchanged) — first results on focus, narrows as you type.
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
        <div className="card" style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, marginTop: 4, maxHeight: 260, overflowY: 'auto', background: 'var(--white)' }}>
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

const SORTS = {
  unit: { label: 'Unit', get: r => (r.unit_number || '').toLowerCase() },
  ro: { label: 'RO #', get: r => (r.ro_number || '').toLowerCase() },
  notes: { label: 'Job / notes', get: r => (r.current_notes || '').toLowerCase() },
  cost: { label: 'Cost', get: r => Number(r.final_cost ?? r.estimated_cost ?? 0) },
  dwell: { label: 'Time out', get: r => dwell(r.date_sent).ms },
  update: { label: 'Last update', get: r => r._lastUpdate ? new Date(r._lastUpdate).getTime() : 0 },
};

export default function UnitsOutTab({ ctx }) {
  const { loc, openRO, openUnit } = ctx;
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchMode, setSearchMode] = useState(null);

  // sort state: which column + direction
  const [sortKey, setSortKey] = useState('dwell');
  const [sortDir, setSortDir] = useState('desc'); // longest-out first by default

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
      const ros = data || [];

      // newest status update per RO (one query, reduce client-side)
      const ids = ros.map(r => r.id);
      let updMap = {};
      if (ids.length) {
        let uq = sb.from('outside_ro_updates')
          .select('outside_ro_id,note,created_at,created_by_name')
          .in('outside_ro_id', ids)
          .order('created_at', { ascending: false })
          .range(0, 9999);
        const { data: ups } = await uq;
        (ups || []).forEach(u => { if (!updMap[u.outside_ro_id]) updMap[u.outside_ro_id] = u; }); // first = newest
      }
      const withUpd = ros.map(r => ({
        ...r,
        _lastUpdate: updMap[r.id]?.created_at || null,
        _lastNote: updMap[r.id]?.note || null,
      }));
      if (!alive) return;
      setRows(withUpd);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [loc.id, ctx.user.company_id, ctx.roOverlayOpen]);

  async function fetchUnits(term) {
    let q = sb.from('units').select('id,unit_number,unit_type,year,make,model,mileage')
      .eq('location_id', loc.id).order('unit_number').limit(10);
    if (ctx.user.company_id) q = q.eq('company_id', ctx.user.company_id);
    if (term) q = q.ilike('unit_number', term + '%');
    const { data } = await q;
    return data || [];
  }
  async function fetchROs(term) {
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

  function toggleSort(key) {
    if (sortKey === key) { setSortDir(d => (d === 'asc' ? 'desc' : 'asc')); }
    else { setSortKey(key); setSortDir(key === 'dwell' || key === 'update' || key === 'cost' ? 'desc' : 'asc'); }
  }

  // group rows by vendor, sort vendors by their worst (longest) dwell, and sort
  // rows within each vendor by the active sort column.
  const groups = useMemo(() => {
    const cmp = (a, b) => {
      const ga = SORTS[sortKey].get(a), gb = SORTS[sortKey].get(b);
      let r = ga < gb ? -1 : ga > gb ? 1 : 0;
      return sortDir === 'asc' ? r : -r;
    };
    const byVendor = {};
    rows.forEach(r => {
      const v = r.vendor_name || 'Unassigned vendor';
      (byVendor[v] = byVendor[v] || []).push(r);
    });
    const list = Object.entries(byVendor).map(([vendor, vrows]) => ({
      vendor,
      rows: vrows.slice().sort(cmp),
      worstDwell: Math.max(...vrows.map(r => dwell(r.date_sent).ms)),
      count: vrows.length,
    }));
    // vendors ordered by longest-out unit (most urgent vendor first)
    list.sort((a, b) => b.worstDwell - a.worstDwell);
    return list;
  }, [rows, sortKey, sortDir]);

  if (loading) return <div className="loading">Loading units out…</div>;

  const arrow = (key) => sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
  const Hdr = ({ k, children, style }) => (
    <button onClick={() => toggleSort(k)} style={{
      background: 'none', border: 'none', cursor: 'pointer', padding: 0,
      fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.3px', textTransform: 'uppercase',
      color: sortKey === k ? 'var(--accent)' : 'var(--muted)', fontWeight: sortKey === k ? 700 : 600,
      textAlign: 'left', whiteSpace: 'nowrap', ...style,
    }}>{children}{arrow(k)}</button>
  );

  return (
    <div style={{ padding: 16, maxWidth: 1000, margin: '0 auto' }}>
      {/* search control */}
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
            <Typeahead placeholder="Type unit number" autoFocus fetcher={fetchUnits}
              display={(u) => `#${u.unit_number}`}
              meta={(u) => [u.year, u.make, u.model].filter(Boolean).join(' ') || (u.mileage != null ? fmtMiles(u.mileage) + ' mi' : '—')}
              onPick={(u) => { resetSearch(); openUnit(u.id); }} />
          </div>
        )}
        {searchMode === 'ro' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>Repair order</span>
              <button className="btn btn-sm" onClick={resetSearch} style={{ marginLeft: 'auto' }}>✕</button>
            </div>
            <Typeahead placeholder="Type RO number or unit number" autoFocus fetcher={fetchROs}
              display={(r) => r.ro_number}
              meta={(r) => `#${r.unit_number}${r.vendor_name ? ' · ' + r.vendor_name : ''}`}
              onPick={(r) => { resetSearch(); openRO(r); }} />
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)', textTransform: 'uppercase' }}>
          Units out · {rows.length} at {groups.length} vendor{groups.length === 1 ? '' : 's'}
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted2)' }}>tap a column to sort</div>
      </div>

      {rows.length === 0 ? (
        <div className="card" style={{ padding: 24, fontSize: 13, color: 'var(--muted)' }}>No units are out for outside repair right now.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* column header row (sortable) */}
          <div className="glow-skip" style={{ display: 'grid', gridTemplateColumns: '110px 1fr 92px 116px 90px 22px', gap: 10, alignItems: 'center', padding: '0 14px' }}>
            <Hdr k="unit">Unit / RO</Hdr>
            <Hdr k="notes">Job / notes</Hdr>
            <Hdr k="cost" style={{ textAlign: 'right' }}>Cost</Hdr>
            <Hdr k="update">Last update</Hdr>
            <Hdr k="dwell">Time out</Hdr>
            <span />
          </div>

          {groups.map(g => (
            <div key={g.vendor} className="card glow-skip" style={{ overflow: 'hidden' }}>
              {/* vendor group header — prominent */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '11px 14px', background: 'var(--red-dim)', borderBottom: '1px solid var(--border2)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.vendor}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, color: 'var(--accent)', background: 'var(--white)', padding: '2px 8px', borderRadius: 10, whiteSpace: 'nowrap' }}>
                    {g.count} unit{g.count === 1 ? '' : 's'}
                  </span>
                </div>
              </div>

              {/* rows for this vendor */}
              {g.rows.map((r, idx) => {
                const dw = dwell(r.date_sent);
                const cls = dw.tone === 'red' ? 'badge-red' : dw.tone === 'amber' ? 'badge-amber' : 'badge-green';
                const cost = r.final_cost ?? r.estimated_cost;
                return (
                  <div
                    key={r.id}
                    onClick={() => openRO(r)}
                    style={{ display: 'grid', gridTemplateColumns: '110px 1fr 92px 116px 90px 22px', gap: 10, alignItems: 'center', padding: '11px 14px', borderTop: idx ? '1px solid var(--border)' : 'none', cursor: 'pointer' }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface2, rgba(0,0,0,0.02))'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                    {/* unit / ro */}
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                      <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 14 }}>{r.unit_number}</span>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted2)' }}>{r.ro_number}</span>
                    </span>
                    {/* job / notes */}
                    <span style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.current_notes || '—'}
                    </span>
                    {/* cost */}
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: cost ? 'var(--text)' : 'var(--muted2)', textAlign: 'right' }}>
                      {cost ? '$' + Math.round(cost).toLocaleString() : '—'}
                    </span>
                    {/* last update */}
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: r._lastUpdate ? 'var(--text)' : 'var(--muted2)' }} title={r._lastNote || ''}>
                      {fmtUpdate(r._lastUpdate)}
                    </span>
                    {/* time out */}
                    <span className={'badge ' + cls} style={{ justifySelf: 'start' }}>{dw.label}</span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted2)', justifySelf: 'end' }}>›</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
