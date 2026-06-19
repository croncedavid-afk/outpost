import React, { useState, useEffect, useRef } from 'react';
import { sb } from '../supabase.js';

// Outpost "Send Out" creates an OUTSIDE RO — identical to Shop Command's outside RO.
// Writes to outside_ros, drawing the next number from this terminal's shared
// per-location/year sequence in the {code}-{seq4}{yy} format, 9500+ band so it
// never collides with inside ROs. Header-only at create time (jobs, costs, tax,
// shipping and fees are entered later on the RO page / review), matching Shop Command.

function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Same format as Shop Command's generateRONumber: {code}-{seq4}{yy}
function makeRONumber(code, seq) {
  const yy = new Date().getFullYear().toString().slice(-2);
  return `${code}-${String(seq).padStart(4, '0')}${yy}`;
}

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
  const [odoSuggest, setOdoSuggest] = useState(null); // { odometer, reading_date, source }
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const unitBoxRef = useRef(null);

  useEffect(() => {
    (async () => {
      const { data } = await sb.from('vendors').select('id,name,city,state').eq('status', 'active').order('name').range(0, 999);
      setVendors(data || []);
    })();
  }, []);

  // close the unit dropdown on outside tap/click
  useEffect(() => {
    function onDown(e) { if (unitBoxRef.current && !unitBoxRef.current.contains(e.target)) setUnitOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown); };
  }, []);

  // unit search within this terminal — first 8 on focus, then narrow as you type
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

  // debounce typing
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
    // most-recent odometer from anywhere (unit record / inside RO / outside RO)
    try {
      const { data } = await sb.rpc('last_unit_odometer', { p_unit_number: u.unit_number });
      const row = Array.isArray(data) ? data[0] : data;
      if (row && row.odometer != null) setOdoSuggest(row);
    } catch { /* suggestion is best-effort */ }
  }

  function useSuggestion() {
    if (odoSuggest?.odometer != null) setOdometer(String(odoSuggest.odometer));
  }

  function fmtMiles(n) {
    return Number(n).toLocaleString();
  }
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
      // Next sequence in this location's 9500+ band for the current year — same
      // approach as Shop Command's outside RO create.
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

      // keep the unit's current odometer fresh when a higher reading is entered (trucks)
      if (odoVal != null && unit.unit_type === 'truck') {
        try { await sb.from('units').update({ mileage: odoVal }).eq('id', unit.id).lt('mileage', odoVal); } catch { /* non-fatal */ }
      }

      setMsg(`Outside RO ${roNum} created for unit ${unit.unit_number}. Add jobs and costs on the RO.`);
      setUnit(null); setUnitQuery(''); setVendorId(''); setReason('');
      setDateSent(todayISO()); setEta(''); setOdometer(''); setOdoSuggest(null);
    } catch (e) { setErr(String(e?.message || e)); }
    setSaving(false);
  }

  const lbl = { fontSize: 11, color: 'var(--muted)', marginBottom: 4, fontFamily: 'var(--mono)' };
  const isTrailer = unit?.unit_type === 'trailer';

  return (
    <div style={{ padding: 16, maxWidth: 560 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)', textTransform: 'uppercase', marginBottom: 12 }}>Send a unit out for outside repair</div>
      <div className="card" style={{ padding: 18 }}>
        {/* unit */}
        <div style={{ position: 'relative', marginBottom: 12 }} ref={unitBoxRef}>
          <div style={lbl}>Unit *</div>
          <input
            className="input"
            placeholder="Type unit number"
            value={unitQuery}
            onFocus={() => { setUnitOpen(true); loadUnits(unitQuery.trim()); }}
            onChange={e => { setUnitQuery(e.target.value); setUnit(null); setUnitOpen(true); }}
          />
          {unitOpen && (
            <div className="card" style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, marginTop: 4, maxHeight: 240, overflowY: 'auto' }}>
              {unitLoading && <div style={{ padding: '9px 12px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)' }}>Searching…</div>}
              {!unitLoading && unitMatches.length === 0 && <div style={{ padding: '9px 12px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)' }}>No matches at this terminal</div>}
              {!unitLoading && unitMatches.map(u => (
                <div
                  key={u.id}
                  onMouseDown={(e) => { e.preventDefault(); pickUnit(u); }}
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
        {/* vendor */}
        <div style={{ marginBottom: 12 }}>
          <div style={lbl}>Vendor *</div>
          <select className="select" value={vendorId} onChange={e => setVendorId(e.target.value)}>
            <option value="">Choose a vendor…</option>
            {vendors.map(v => <option key={v.id} value={v.id}>{v.name}{v.city ? ` — ${v.city}, ${v.state}` : ''}</option>)}
          </select>
        </div>
        {/* odometer */}
        <div style={{ marginBottom: 12 }}>
          <div style={lbl}>Odometer {isTrailer ? '(optional — trailer)' : '(optional)'}</div>
          <input className="input" type="number" inputMode="numeric" placeholder={isTrailer ? 'hub odometer, if equipped' : 'current miles'} value={odometer} onChange={e => setOdometer(e.target.value)} />
          {odoSuggest && (
            <div
              onMouseDown={(e) => { e.preventDefault(); useSuggestion(); }}
              style={{ marginTop: 6, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent2)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--muted)' }}>Last reading:</span>
              <strong>{fmtMiles(odoSuggest.odometer)} mi</strong>
              <span style={{ color: 'var(--muted2)' }}>· {odoSuggest.source} · {fmtDate(odoSuggest.reading_date)}</span>
              <span style={{ textDecoration: 'underline' }}>— tap to use</span>
            </div>
          )}
        </div>
        {/* reason */}
        <div style={{ marginBottom: 14 }}>
          <div style={lbl}>Reason / complaint *</div>
          <textarea className="textarea" rows={2} placeholder="e.g. PM A due; air leak; DOT inspection" value={reason} onChange={e => setReason(e.target.value)} />
        </div>
        {err && <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent)', marginBottom: 10 }}>⚠ {err}</div>}
        {msg && <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--green)', marginBottom: 10 }}>✓ {msg}</div>}
        <button className="btn btn-primary" onClick={send} disabled={saving} style={{ width: '100%' }}>{saving ? 'Creating…' : 'Create Outside RO'}</button>
      </div>
    </div>
  );
}
