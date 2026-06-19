import React, { useState, useEffect } from 'react';
import { sb } from '../supabase.js';

export default function ApprovalsTab({ ctx }) {
  const { loc, user } = ctx;
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(null);

  async function load() {
    setLoading(true);
    // open vendor ROs with an estimate but not yet RM-approved
    const { data: vros } = await sb.from('vendor_ro_headers')
      .select('id,ro_number,unit_number,unit_id,vendor_name_display,complaint,estimated_cost,final_cost,opened_date,rm_approved_by,reviewed_by,status')
      .eq('company_id', user.company_id).is('closed_date', null)
      .not('estimated_cost', 'is', null).is('rm_approved_by', null)
      .order('opened_date', { ascending: true }).range(0, 9999);
    // limit to units at this terminal + attach book/repair context
    const unitIds = [...new Set((vros || []).map(v => v.unit_id).filter(Boolean))];
    const uInfo = {};
    if (unitIds.length) {
      for (let i = 0; i < unitIds.length; i += 300) {
        const { data: us } = await sb.from('units').select('id,location_id').in('id', unitIds.slice(i, i + 300));
        (us || []).forEach(u => { uInfo[u.id] = u; });
      }
    }
    const here = (vros || []).filter(v => !v.unit_id || uInfo[v.unit_id]?.location_id === loc.id)
      .map(v => ({ ...v, book_value: v.unit_id ? (uInfo[v.unit_id]?.book_value ?? null) : null }));
    setRows(here);
    setLoading(false);
  }
  useEffect(() => { load(); }, [loc.id, user.company_id]);

  async function decide(row, approve) {
    setActing(row.id);
    try {
      const patch = approve
        ? { rm_approved_by: user.id, rm_approved_date: new Date().toISOString() }
        : { status: 'hold' };
      await sb.from('vendor_ro_headers').update(patch).eq('id', row.id);
      await load();
    } catch (e) { /* surface inline if needed */ }
    setActing(null);
  }

  if (loading) return <div className="loading">Loading approvals…</div>;

  return (
    <div style={{ padding: 16 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)', textTransform: 'uppercase', marginBottom: 8 }}>
        Estimates awaiting your approval · {rows.length}
      </div>
      {rows.length === 0 ? (
        <div className="card" style={{ padding: 24, fontSize: 13, color: 'var(--muted)' }}>No estimates are waiting on you.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map(v => {
            const est = Number(v.estimated_cost) || 0;
            const bv = v.book_value != null ? Number(v.book_value) : null;
            const pct = (bv && bv > 0) ? Math.round(100 * est / bv) : null;
            return (
              <div key={v.id} className="card" style={{ padding: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 14, minWidth: 64 }}>{v.unit_number}</span>
                  <span style={{ fontSize: 12, color: 'var(--muted)', flex: 1 }}>{v.vendor_name_display || 'Vendor'} · est. ${est.toLocaleString()}</span>
                  <span className="badge badge-amber">awaiting you</span>
                </div>
                {v.complaint && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8, paddingLeft: 76 }}>{v.complaint}</div>}
                {/* repair-vs-replace context (AI advisor enriches this later) */}
                {bv != null && (
                  <div style={{ fontSize: 11, color: 'var(--muted2)', marginTop: 6, paddingLeft: 76 }}>
                    repair ${est.toLocaleString()} vs book value ${bv.toLocaleString()}{pct != null ? ` · ${pct}%` : ''}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 12, paddingLeft: 76 }}>
                  <button className="btn btn-sm" onClick={() => decide(v, true)} disabled={acting === v.id} style={{ background: 'var(--green-dim)', color: 'var(--green)', border: '1px solid var(--green)' }}>{acting === v.id ? '…' : 'Approve'}</button>
                  <button className="btn btn-sm" onClick={() => decide(v, false)} disabled={acting === v.id}>Hold</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
