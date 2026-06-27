import React, { useState, useEffect, useRef, useMemo } from 'react';
import { sb } from '../supabase.js';

// Outpost "Send Out" creates an OUTSIDE RO — identical to Shop Command's outside RO.
// Writes to outside_ros, drawing the next number from this terminal's shared
// per-location/year sequence in the {code}-{seq4}{yy} format, 9500+ band so it
// never collides with inside ROs. Header-only at create time (jobs, costs, tax,
// shipping and fees are entered later on the RO page / review), matching Shop Command.
//
// LAYOUT: two columns. LEFT = the create-an-outside-RO form. RIGHT = a "suggested
// to send out" panel — units overdue for PM (then coming-due if few are overdue)
// and units with open DVIR defects (OOS first, then longest-running). Tapping a
// suggestion pre-fills the unit on the left. Stacks to one column on mobile.
// (Samsara + TMW route logic will layer into the suggestions later.)

const DAY_MS = 86400000;

// PM status — mirrors RadarTab / the platform getPMStatus (defaults 90d / 45k mi).
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

function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function makeRONumber(code, seq) {
  const yy = new Date().getFullYear().toString().slice(-2);
  return `${code}-${String(seq).padStart(4, '0')}${yy}`;
}
function ageDays(ts) { return ts ? Math.max(0, Math.floor((Date.now() - new Date(ts)) / DAY_MS)) : 0; }

export default function SendOutTab({ ctx }) {
  const { loc, user } = ctx;
  const [unitQuery, setUnitQuery] = useState('');
  const [unitMatches, setUnitMatches] = useState([]);
  const [unitOpen, setUnitOpen] = useState(false);
  const [unitLoading, setUnitLoading] = useState(false);
  const [unit, setUnit] = useState(null);
  const [vendors, setVendors] = useState([]);
  const [vendorId, setVendorId] = useState('');
  const [reason, setReason] = useState('');
  const [dateSent, setDateSent] = useState(todayISO());
  const [eta, setEta] = useState('');
  const [odometer, setOdometer] = useState('');
  const [odoSuggest, setOdoSuggest] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const unitBoxRef = useRef(null);

  // suggestion-panel data
  const [sugUnits, setSugUnits] = useState([]);
  const [sugIntervals, setSugIntervals] = useState([]);
  const [sugDefects, setSugDefects] = useState([]);
  const [sugLoading, setSugLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    (async () => {
      const { data } = await sb.from('vendors').select('id,name,city,state').eq('status', 'active').order('name').range(0, 999);
      setVendors(data || []);
    })();
  }, []);

  // load suggestion data (same sources RadarTab uses for PM, plus open defects)
  useEffect(() => {
    let alive = true;
    (async () => {
      setSugLoading(true);
      const [uRes, iRes, dRes] = await Promise.all([
        sb.from('units').select('*').eq('location_id', loc.id).eq('status', 'active').order('unit_number').range(0, 49999),
        sb.from('pm_intervals').select('*'),
        (() => {
          let q = sb.from('unit_defects').select('id,unit_number,severity,description,reported_at,reported_by_name')
            .eq('location_id', loc.id).eq('status', 'open').order('reported_at', { ascending: true }).range(0, 9999);
          if (user.company_id) q = q.eq('company_id', user.company_id);
          return q;
        })(),
      ]);
      if (!alive) return;
      setSugUnits(uRes.data || []);
      setSugIntervals(iRes.data || []);
      setSugDefects(dRes.data || []);
      setSugLoading(false);
    })();
    return () => { alive = false; };
  }, [loc.id, user.company_id, reloadKey]);

  // close the unit dropdown on outside tap/click
  useEffect(() => {
    function onDown(e) { if (unitBoxRef.current && !unitBoxRef.current.contains(e.target)) setUnitOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown); };
  }, []);

  async function loadUnits(term) {
    setUnitLoading(true);
    try {
      let query = sb.from('units')
        .select('id,unit_number,unit_type,mileage,year,make,model')
        .eq('location_id', loc.id)
        .order('unit_number')
        .limit(8);
      if (user.company_id) query = query.eq('company_id', user.company_id);
      if (term) query = query.ilike('unit_number', term + '%');
      const { data } = await query;
      setUnitMatches(data || []);
    } finally { setUnitLoading(false); }
  }

  useEffect(() => {
    if (!unitOpen) return;
    let alive = true;
    const t = setTimeout(() => { if (alive) loadUnits(unitQuery.trim()); }, 200);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitQuery, unitOpen, loc.id, user.company_id]);

  async function pickUnit(u) {
    setUnit(u);
    setUnitQuery(u.unit_number);
    setUnitMatches([]);
    setUnitOpen(false);
    setOdometer('');
    setOdoSuggest(null);
    try {
      const { data } = await sb.rpc('last_unit_odometer', { p_unit_number: u.unit_number });
      const row = Array.isArray(data) ? data[0] : data;
      if (row && row.odometer != null) setOdoSuggest(row);
    } catch { /* best-effort */ }
  }

  // pick a unit straight from a suggestion (fetch the columns the form needs)
  async function pickSuggestedUnit(unitNumber) {
    let q = sb.from('units').select('id,unit_number,unit_type,mileage,year,make,model')
      .eq('location_id', loc.id).eq('unit_number', unitNumber).limit(1);
    if (user.company_id) q = q.eq('company_id', user.company_id);
    const { data } = await q;
    const u = (data || [])[0];
    if (u) {
      await pickUnit(u);
      // scroll the form into view on mobile so the picked unit is visible
      try { unitBoxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
    }
  }

  function useSuggestion() {
    if (odoSuggest?.odometer != null) setOdometer(String(odoSuggest.odometer));
  }
  function fmtMiles(n) { return Number(n).toLocaleString(); }
  function fmtDate(d) {
    if (!d) return '';
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  async function send() {
    setErr(''); setMsg('');
    if (!unit) { setErr('Pick a unit.'); return; }
    if (!vendorId) { setErr('Choose a vendor.'); return; }
    if (!reason.trim()) { setErr('Add a reason for sending it out.'); return; }
    setSaving(true);
    try {
      const yy = new Date().getFullYear().toString().slice(-2);
      const { data: existing } = await sb
        .from('outside_ros')
        .select('ro_number')
        .eq('location_id', loc.id)
        .like('ro_number', `${loc.code}-%${yy}`)
        .order('ro_number', { ascending: false })
        .limit(1);
      let nextSeq = 9500;
      if (existing && existing.length) {
        const m = existing[0].ro_number.match(/-(\d{4})\d{2}$/);
        if (m) nextSeq = Math.max(9500, parseInt(m[1], 10) + 1);
      }
      const roNum = makeRONumber(loc.code, nextSeq);
      const v = vendors.find(x => x.id === vendorId);
      const odoVal = (odometer === '' || isNaN(Number(odometer))) ? null : Math.round(Number(odometer));

      const { data: inserted, error } = await sb.from('outside_ros').insert({
        ro_number: roNum,
        unit_number: unit.unit_number,
        location_id: loc.id,
        vendor_name: v?.name || '',
        date_sent: dateSent,
        eta: eta || null,
        current_notes: reason.trim(),
        status: 'inprogress',
        odometer: odoVal,
        created_by: user.id,
        ...(user.company_id ? { company_id: user.company_id } : {}),
      }).select('*').single();
      if (error) { setErr(error.message); setSaving(false); return; }

      if (odoVal != null && unit.unit_type === 'truck') {
        try { await sb.from('units').update({ mileage: odoVal }).eq('id', unit.id).lt('mileage', odoVal); } catch { /* non-fatal */ }
      }

      setMsg(`Outside RO ${roNum} created for unit ${unit.unit_number}. Add jobs and costs on the RO.`);
      setUnit(null); setUnitQuery(''); setVendorId(''); setReason('');
      setDateSent(todayISO()); setEta(''); setOdometer(''); setOdoSuggest(null);
      setReloadKey(k => k + 1); // refresh suggestions (this unit may now be out)
    } catch (e) { setErr(String(e?.message || e)); }
    setSaving(false);
  }

  // ── derive the suggestion lists ────────────────────────────────
  const withStatus = useMemo(() => sugUnits.map(u => {
    const iv = sugIntervals.find(i => i.unit_subtype === (u.unit_subtype || u.unit_type)) || {};
    return { ...u, pm: pmStatus(u, iv) };
  }), [sugUnits, sugIntervals]);

  const pmSuggest = useMemo(() => {
    const overdue = withStatus.filter(u => u.pm.status === 'overdue')
      .sort((a, b) => (b.pm.daysOverdue || 0) - (a.pm.daysOverdue || 0));
    const dueSoon = withStatus.filter(u => u.pm.status === 'due_soon')
      .sort((a, b) => (a.pm.daysToDue || 0) - (b.pm.daysToDue || 0));
    // overdue first; if only a couple overdue, top up with coming-due
    let list = overdue.slice();
    if (overdue.length < 3) list = list.concat(dueSoon.slice(0, 5 - overdue.length));
    return list.slice(0, 6);
  }, [withStatus]);

  const dvirSuggest = useMemo(() => {
    // OOS first (any age), then longest-running minor defects. Cap so the
    // combined PM+DVIR panel stays ~10 and easy to scan.
    const oos = sugDefects.filter(d => d.severity === 'oos');
    const minor = sugDefects.filter(d => d.severity !== 'oos');
    const room = Math.max(4, 10 - pmSuggest.length); // always show OOS; give DVIR at least 4 slots
    return [...oos, ...minor].slice(0, room);
  }, [sugDefects, pmSuggest.length]);

  const lbl = { fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginBottom: 6, fontFamily: 'var(--mono)', letterSpacing: '.3px' };
  const isTrailer = unit?.unit_type === 'trailer';

  return (
    <div style={{ padding: '20px 16px', maxWidth: 1100, margin: '0 auto' }}>
      {/* header */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 19, fontWeight: 700, color: 'var(--text)' }}>Send Out</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted2)', marginTop: 2 }}>
          {loc ? `${loc.code} ${loc.name?.replace(' Terminal', '')} · ` : ''}send a unit to an outside vendor for repair
        </div>
      </div>

      {/* two columns: form (left) + suggestions (right). Stacks on narrow screens. */}
      <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>

        {/* ── LEFT: the form ───────────────────────────────────── */}
        <div style={{ flex: '1 1 420px', minWidth: 300, maxWidth: 600 }}>
          <div className="card glow-skip" style={{ padding: 22 }}>
            {/* unit */}
            <div style={{ position: 'relative', marginBottom: 18 }} ref={unitBoxRef}>
              <div style={lbl}>Unit <span style={{ color: 'var(--accent)' }}>*</span></div>
              {unit ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 14px', border: '1.5px solid var(--accent)', borderRadius: 'var(--radius-md)', background: 'var(--green-dim)' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 15 }}>{unit.unit_number}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>
                      {[unit.year, unit.make, unit.model].filter(Boolean).join(' ') || unit.unit_type}
                      {unit.mileage != null && <span style={{ color: 'var(--muted2)' }}> · {fmtMiles(unit.mileage)} mi</span>}
                    </div>
                  </div>
                  <button
                    onClick={() => { setUnit(null); setUnitQuery(''); setOdometer(''); setOdoSuggest(null); setUnitOpen(true); setTimeout(() => loadUnits(''), 0); }}
                    style={{ flexShrink: 0, fontFamily: 'var(--mono)', fontSize: 11, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border2)', background: 'var(--white)', color: 'var(--muted)', cursor: 'pointer' }}>
                    change
                  </button>
                </div>
              ) : (
                <input
                  className="input"
                  style={{ fontSize: 15, padding: '12px 14px' }}
                  placeholder="Type unit number…"
                  value={unitQuery}
                  onFocus={() => { setUnitOpen(true); loadUnits(unitQuery.trim()); }}
                  onChange={e => { setUnitQuery(e.target.value); setUnit(null); setUnitOpen(true); }}
                />
              )}
              {unitOpen && !unit && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, marginTop: 6, maxHeight: 280, overflowY: 'auto', background: 'var(--white)', border: '1px solid var(--border2)', borderRadius: 'var(--radius-md)', boxShadow: '0 12px 32px rgba(0,0,0,.16)' }}>
                  {unitLoading && <div style={{ padding: '11px 14px', fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted2)' }}>Searching…</div>}
                  {!unitLoading && unitMatches.length === 0 && <div style={{ padding: '11px 14px', fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted2)' }}>No matches at this terminal</div>}
                  {!unitLoading && unitMatches.map(u => (
                    <div
                      key={u.id}
                      onMouseDown={(e) => { e.preventDefault(); pickUnit(u); }}
                      style={{ padding: '11px 14px', cursor: 'pointer', borderBottom: '1px solid var(--border)', fontSize: 13.5, display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--surface2)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{u.unit_number}</span>
                        <span style={{ color: 'var(--muted)', marginLeft: 8 }}>{[u.year, u.make, u.model].filter(Boolean).join(' ') || u.unit_type}</span>
                      </span>
                      {u.mileage != null && <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted2)', whiteSpace: 'nowrap' }}>{fmtMiles(u.mileage)} mi</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* vendor */}
            <div style={{ marginBottom: 18 }}>
              <div style={lbl}>Vendor <span style={{ color: 'var(--accent)' }}>*</span></div>
              <select className="select" style={{ fontSize: 14, padding: '12px 14px' }} value={vendorId} onChange={e => setVendorId(e.target.value)}>
                <option value="">Choose a vendor…</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}{v.city ? ` — ${v.city}, ${v.state}` : ''}</option>)}
              </select>
            </div>

            {/* odometer */}
            <div style={{ marginBottom: 18 }}>
              <div style={lbl}>Odometer <span style={{ color: 'var(--muted2)', fontWeight: 400 }}>{isTrailer ? '(optional — trailer)' : '(optional)'}</span></div>
              <input className="input" style={{ fontSize: 14, padding: '12px 14px' }} type="number" inputMode="numeric" placeholder={isTrailer ? 'hub odometer, if equipped' : 'current miles'} value={odometer} onChange={e => setOdometer(e.target.value)} />
              {odoSuggest && (
                <div
                  onMouseDown={(e) => { e.preventDefault(); useSuggestion(); }}
                  style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent2)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--muted)' }}>Last reading:</span>
                  <strong>{fmtMiles(odoSuggest.odometer)} mi</strong>
                  <span style={{ color: 'var(--muted2)' }}>· {odoSuggest.source} · {fmtDate(odoSuggest.reading_date)}</span>
                  <span style={{ textDecoration: 'underline' }}>— tap to use</span>
                </div>
              )}
            </div>

            {/* reason */}
            <div style={{ marginBottom: 20 }}>
              <div style={lbl}>Reason / complaint <span style={{ color: 'var(--accent)' }}>*</span></div>
              <textarea className="textarea" style={{ fontSize: 14, padding: '12px 14px', minHeight: 80, resize: 'vertical' }} rows={3} placeholder="e.g. PM A due; air leak; DOT inspection" value={reason} onChange={e => setReason(e.target.value)} />
            </div>

            {err && <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--accent)', marginBottom: 12, padding: '8px 12px', background: 'rgba(142,0,0,.06)', borderRadius: 6 }}>⚠ {err}</div>}
            {msg && <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--green)', marginBottom: 12, padding: '8px 12px', background: 'var(--green-dim)', borderRadius: 6 }}>✓ {msg}</div>}
            <button className="btn btn-primary" onClick={send} disabled={saving} style={{ width: '100%', fontSize: 15, padding: '13px' }}>{saving ? 'Creating…' : 'Create Outside RO'}</button>
          </div>
        </div>

        {/* ── RIGHT: suggestions ───────────────────────────────── */}
        <div style={{ flex: '1 1 360px', minWidth: 300 }}>
          <SuggestPanel
            loading={sugLoading}
            pm={pmSuggest}
            dvir={dvirSuggest}
            selectedUnit={unit?.unit_number}
            onPick={pickSuggestedUnit}
          />
        </div>
      </div>
    </div>
  );
}

/* ── suggestion panel ───────────────────────────────────────────── */
function SuggestPanel({ loading, pm, dvir, selectedUnit, onPick }) {
  const nothing = !loading && pm.length === 0 && dvir.length === 0;
  return (
    <div className="card glow-skip" style={{ padding: 18 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>Suggested to send out</div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted2)', marginBottom: 14 }}>
        tap a unit to load it into the form
      </div>

      {loading && <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted2)', padding: '8px 2px' }}>Reading PM &amp; defect status…</div>}

      {nothing && (
        <div style={{ fontSize: 13, color: 'var(--muted)', padding: '8px 2px' }}>
          Nothing urgent right now — no overdue PM and no open defects at this terminal. 🎉
        </div>
      )}

      {!loading && pm.length > 0 && (
        <div style={{ marginBottom: dvir.length ? 18 : 0 }}>
          <SectionHead icon="🔧" label="PM due" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {pm.map(u => {
              const od = u.pm.status === 'overdue';
              const detail = od
                ? `${u.pm.daysOverdue || 0}d overdue`
                : `due soon · ${u.pm.daysToDue || 0}d`;
              return (
                <SuggestRow
                  key={'pm-' + u.id}
                  unitNumber={u.unit_number}
                  sub={[u.year, u.make, u.model].filter(Boolean).join(' ') || u.unit_type}
                  badge={od ? 'OVERDUE' : 'DUE SOON'}
                  badgeColor={od ? 'var(--accent)' : 'var(--amber)'}
                  detail={detail}
                  detailColor={od ? 'var(--accent)' : 'var(--amber)'}
                  selected={selectedUnit === u.unit_number}
                  onPick={() => onPick(u.unit_number)}
                />
              );
            })}
          </div>
        </div>
      )}

      {!loading && dvir.length > 0 && (
        <div>
          <SectionHead icon="⚠" label="DVIR defects" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {dvir.map(d => {
              const oos = d.severity === 'oos';
              return (
                <SuggestRow
                  key={'dv-' + d.id}
                  unitNumber={d.unit_number}
                  sub={d.description}
                  badge={oos ? 'OOS' : 'MINOR'}
                  badgeColor={oos ? 'var(--accent)' : 'var(--amber)'}
                  detail={`${ageDays(d.reported_at)}d open`}
                  detailColor={oos ? 'var(--accent)' : 'var(--muted2)'}
                  selected={selectedUnit === d.unit_number}
                  onPick={() => onPick(d.unit_number)}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionHead({ icon, label }) {
  return (
    <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.4px', marginBottom: 8, textTransform: 'uppercase' }}>
      {icon} {label}
    </div>
  );
}

function SuggestRow({ unitNumber, sub, badge, badgeColor, detail, detailColor, selected, onPick }) {
  return (
    <button
      onClick={onPick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
        padding: '9px 11px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
        border: selected ? '1.5px solid var(--accent)' : '1px solid var(--border)',
        background: selected ? 'var(--green-dim)' : 'var(--white)',
        borderLeft: `3px solid ${badgeColor}`,
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--surface2)'; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'var(--white)'; }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 2 }}>
          <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13.5 }}>{unitNumber}</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 8.5, fontWeight: 700, letterSpacing: '.3px', padding: '1px 5px', borderRadius: 3, color: '#fff', background: badgeColor }}>{badge}</span>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>
      </div>
      <div style={{ flexShrink: 0, fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600, color: detailColor, whiteSpace: 'nowrap' }}>{detail}</div>
    </button>
  );
}
