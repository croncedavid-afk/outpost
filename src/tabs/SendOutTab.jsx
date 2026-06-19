import React, { useState, useEffect, useRef } from 'react';
import { sb } from '../supabase.js';

export default function SendOutTab({ ctx }) {
  const { loc, user } = ctx;
  const [unitQuery, setUnitQuery] = useState('');
  const [unitMatches, setUnitMatches] = useState([]);
  const [unit, setUnit] = useState(null);
  const [vendors, setVendors] = useState([]);
  const [vendorId, setVendorId] = useState('');
  const [reason, setReason] = useState('');
  const [odometer, setOdometer] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      const { data } = await sb.from('vendors').select('id,name,city,state').eq('status', 'active').order('name').range(0, 999);
      setVendors(data || []);
    })();
  }, []);

  // unit typeahead (within this terminal)
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      const q = unitQuery.trim();
      if (!q) { setUnitMatches([]); return; }
      let query = sb.from('units').select('id,unit_number,unit_type,mileage,year,make,model').eq('location_id', loc.id).ilike('unit_number', q + '%').order('unit_number').limit(8);
      if (user.company_id) query = query.eq('company_id', user.company_id);
      const { data } = await query;
      if (alive) setUnitMatches(data || []);
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [unitQuery, loc.id, user.company_id]);

  function pickUnit(u) {
    setUnit(u); setUnitQuery(u.unit_number); setUnitMatches([]);
    if (u.unit_type === 'truck' && u.mileage != null) setOdometer(String(u.mileage));
  }

  async function send() {
    setErr(''); setMsg('');
    if (!unit) { setErr('Pick a unit.'); return; }
    if (!vendorId) { setErr('Choose a vendor.'); return; }
    if (!reason.trim()) { setErr('Add a reason for sending it out.'); return; }
    setSaving(true);
    try {
      // sequence per company for VNDR- format
      const { count } = await sb.from('vendor_ro_headers').select('*', { count: 'exact', head: true }).eq('company_id', user.company_id);
      const seq = (count || 0) + 1;
      const ro_number = 'VNDR-' + String(seq).padStart(6, '0');
      const v = vendors.find(x => x.id === vendorId);
      const odoVal = (odometer === '' || isNaN(Number(odometer))) ? null : Math.round(Number(odometer));
      const { data: inserted, error } = await sb.from('vendor_ro_headers').insert({
        ro_number, ro_sequence: seq,
        unit_number: unit.unit_number, unit_id: unit.id, unit_type: unit.unit_type || null,
        complaint: reason.trim(),
        vendor_master_id: vendorId, vendor_name_display: v?.name || null,
        company_id: user.company_id, odometer: odoVal,
        status: 'open', source: 'outpost',
        opened_date: new Date().toISOString(),
      }).select('*').single();
      if (error) { setErr(error.message); setSaving(false); return; }
      // bump unit odometer if higher (trucks)
      if (odoVal != null && unit.unit_type === 'truck') {
        try { await sb.from('units').update({ mileage: odoVal }).eq('id', unit.id).lt('mileage', odoVal); } catch {}
      }
      setMsg(`Sent out — ${ro_number} created for unit ${unit.unit_number}.`);
      setUnit(null); setUnitQuery(''); setVendorId(''); setReason(''); setOdometer('');
    } catch (e) { setErr(String(e?.message || e)); }
    setSaving(false);
  }

  const lbl = { fontSize: 11, color: 'var(--muted)', marginBottom: 4, fontFamily: 'var(--mono)' };
  const isTrailer = unit?.unit_type === 'trailer';

  return (
    <div style={{ padding: 16, maxWidth: 560 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)', textTransform: 'uppercase', marginBottom: 12 }}>Send a unit out to a vendor</div>
      <div className="card" style={{ padding: 18 }}>
        {/* unit */}
        <div style={{ position: 'relative', marginBottom: 12 }}>
          <div style={lbl}>Unit *</div>
          <input className="input" placeholder="Type unit number" value={unitQuery} onChange={e => { setUnitQuery(e.target.value); setUnit(null); }} />
          {unitMatches.length > 0 && (
            <div className="card" style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 5, marginTop: 4, maxHeight: 220, overflowY: 'auto' }}>
              {unitMatches.map(u => (
                <div key={u.id} onClick={() => pickUnit(u)} style={{ padding: '9px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{u.unit_number}</span>
                  <span style={{ color: 'var(--muted)', marginLeft: 8 }}>{[u.year, u.make, u.model].filter(Boolean).join(' ') || u.unit_type}</span>
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
        {/* odometer (truck) */}
        <div style={{ marginBottom: 12 }}>
          <div style={lbl}>Odometer {isTrailer ? '(optional — trailer)' : unit ? '' : ''}</div>
          <input className="input" type="number" inputMode="numeric" placeholder={isTrailer ? 'hub odometer, if equipped' : 'current miles'} value={odometer} onChange={e => setOdometer(e.target.value)} />
        </div>
        {/* reason */}
        <div style={{ marginBottom: 14 }}>
          <div style={lbl}>Reason / complaint *</div>
          <textarea className="textarea" rows={2} placeholder="e.g. PM A due; air leak; DOT inspection" value={reason} onChange={e => setReason(e.target.value)} />
        </div>
        {err && <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent)', marginBottom: 10 }}>⚠ {err}</div>}
        {msg && <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--green)', marginBottom: 10 }}>✓ {msg}</div>}
        <button className="btn btn-primary" onClick={send} disabled={saving} style={{ width: '100%' }}>{saving ? 'Creating…' : 'Create vendor RO'}</button>
      </div>
    </div>
  );
}
