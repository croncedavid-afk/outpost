import React, { useState, useEffect, useMemo } from 'react';
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 10, marginBottom: 18 }}>
        <Metric label="Fleet active" value={units.length} sub="units" />
        <Metric label="PM current" value={current.length} sub="on schedule" color="var(--green)" />
        <Metric label="PM due soon" value={dueSoon.length} sub="approaching" color="var(--amber)" />
        <Metric label="PM overdue" value={overdue.length} sub="act now" color="var(--accent)" />
        <Metric label="Out at vendor" value={vendorOut.length} sub="in service" />
      </div>

      {/* AI forecast panel mounts here in step 2 */}

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
