import React, { useState, useEffect } from 'react';
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
  const { loc } = ctx;
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      // open vendor ROs (not yet closed) — scoped to company; unit must be at this terminal
      const { data: vros } = await sb.from('vendor_ro_headers')
        .select('id,ro_number,unit_number,unit_id,vendor_name_display,complaint,opened_date,estimated_cost,status')
        .eq('company_id', ctx.user.company_id).is('closed_date', null)
        .order('opened_date', { ascending: true }).range(0, 9999);
      // keep only units domiciled at this terminal
      const unitIds = [...new Set((vros || []).map(v => v.unit_id).filter(Boolean))];
      let here = new Set();
      if (unitIds.length) {
        for (let i = 0; i < unitIds.length; i += 300) {
          const { data: us } = await sb.from('units').select('id,location_id').in('id', unitIds.slice(i, i + 300));
          (us || []).forEach(u => { if (u.location_id === loc.id) here.add(u.id); });
        }
      }
      if (!alive) return;
      setRows((vros || []).filter(v => !v.unit_id || here.has(v.unit_id)));
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [loc.id, ctx.user.company_id]);

  if (loading) return <div className="loading">Loading units out…</div>;

  return (
    <div style={{ padding: 16 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)', textTransform: 'uppercase', marginBottom: 8 }}>
        Units out · {rows.length} at a vendor
      </div>
      {rows.length === 0 ? (
        <div className="card" style={{ padding: 24, fontSize: 13, color: 'var(--muted)' }}>No units are out at a vendor right now.</div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          {rows.map((v, idx) => {
            const dw = dwell(v.opened_date);
            const cls = dw.tone === 'red' ? 'badge-red' : dw.tone === 'amber' ? 'badge-amber' : 'badge-green';
            return (
              <div key={v.id} style={{ padding: '12px 14px', borderTop: idx ? '1px solid var(--border)' : 'none', display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 14, minWidth: 64 }}>{v.unit_number}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)', flex: 1 }}>
                  {v.vendor_name_display || 'Vendor'}{v.complaint ? ' · ' + v.complaint.slice(0, 48) : ''}
                  {v.estimated_cost ? ' · est. $' + Math.round(v.estimated_cost).toLocaleString() : ''}
                </span>
                <span className={'badge ' + cls}>{dw.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
