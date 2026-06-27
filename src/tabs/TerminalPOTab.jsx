import React, { useState, useEffect, useMemo } from 'react';
import { sb } from '../supabase.js';

/* ════════════════════════════════════════════════════════════════════
   TERMINAL POs (Outpost tab)
   - Prominent "Create PO" button → FleetStock PO page in spend mode
   - Monthly POSTED spend (fin_entries, this terminal) with bucket drill-down
   - List of terminal POs (po_mode='spend'), defaulted to OPEN + this month
   Read-only over shared tables; the PO itself opens in FleetStock.
   ════════════════════════════════════════════════════════════════════ */

function money(n) { return (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' }); }
function monthKey(d) { const x = d ? new Date(d) : new Date(); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0'); }
function monthLabel(k) { return new Date(k + '-01T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }
function monthBounds(k) {
  const [y, m] = k.split('-').map(Number);
  const from = `${k}-01`;
  const last = new Date(y, m, 0).getDate();
  const to = `${k}-${String(last).padStart(2, '0')}`;
  return { from, to };
}
function fmtDate(s) { if (!s) return '—'; try { return new Date(String(s).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch { return s; } }

export default function TerminalPOTab({ ctx }) {
  const { user, loc, issueTerminalPO } = ctx;
  const [month, setMonth] = useState(monthKey());
  const [statusFilter, setStatusFilter] = useState('active'); // active(open+draft) | open | draft | received | all
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState([]);     // spend-mode POs at this location
  const [catById, setCatById] = useState({});   // category id -> name
  const [spendRows, setSpendRows] = useState([]); // fin_entries for the month
  const [poTotals, setPoTotals] = useState({}); // order_id -> summed line total
  const [openBucket, setOpenBucket] = useState(null);

  const locId = loc?.id;

  async function load() {
    if (!locId) return;
    setLoading(true);
    try {
      // terminal-side categories (for bucket labels)
      let cq = sb.from('fin_categories').select('id,name,side,kind');
      if (user.company_id) cq = cq.eq('company_id', user.company_id);
      // spend-mode POs at this location
      let oq = sb.from('fs_orders').select('*').eq('location_id', locId).eq('po_mode', 'spend').order('date_ordered', { ascending: false }).range(0, 49999);
      if (user.company_id) oq = oq.eq('company_id', user.company_id);
      // posted GL spend for the month at this location
      const { from, to } = monthBounds(month);
      let fq = sb.from('fin_entries').select('id,amount,category_id,entry_date,order_id,description,direction').eq('location_id', locId).eq('direction', 'expense').eq('source_table', 'fs_order_lines').gte('entry_date', from).lte('entry_date', to).range(0, 49999);
      if (user.company_id) fq = fq.eq('company_id', user.company_id);

      const [{ data: cats }, { data: ords }, { data: fins }] = await Promise.all([cq, oq, fq]);
      const cm = {}; (cats || []).forEach(c => { cm[c.id] = c.name; });
      setCatById(cm);
      setOrders(ords || []);
      setSpendRows(fins || []);
      // per-PO totals from their lines (fs_orders has no total column)
      const ids = (ords || []).map(o => o.id);
      if (ids.length) {
        let lq = sb.from('fs_order_lines').select('order_id,line_total').in('order_id', ids).range(0, 49999);
        if (user.company_id) lq = lq.eq('company_id', user.company_id);
        const { data: lls } = await lq;
        const tm = {}; (lls || []).forEach(l => { tm[l.order_id] = (tm[l.order_id] || 0) + (Number(l.line_total) || 0); });
        setPoTotals(tm);
      } else { setPoTotals({}); }
    } catch (e) { console.warn('terminal PO load', e); }
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [locId, month]);

  // bucket totals from posted GL spend
  const buckets = useMemo(() => {
    const m = {};
    spendRows.forEach(r => {
      const name = catById[r.category_id] || 'Uncategorized';
      m[name] = (m[name] || 0) + (Number(r.amount) || 0);
    });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [spendRows, catById]);
  const monthTotal = useMemo(() => spendRows.reduce((a, r) => a + (Number(r.amount) || 0), 0), [spendRows]);

  // drafts get their own tile (not scoped to month — a draft holds its number until issued)
  const draftOrders = useMemo(() => orders.filter(o => o.status === 'draft'), [orders]);
  const showDraftTile = (statusFilter === 'active' || statusFilter === 'draft' || statusFilter === 'all') && draftOrders.length > 0;

  // PO list: drafts live in the tile, never the table. Month scope applies to open/received.
  const shownOrders = useMemo(() => {
    return orders.filter(o => {
      if (o.status === 'draft') return false; // tile only
      if (statusFilter === 'draft') return false; // draft-only view: just the tile
      if (statusFilter === 'open' && o.status !== 'open') return false;
      if (statusFilter === 'active' && o.status !== 'open') return false; // active table shows open (drafts in tile)
      if (statusFilter === 'received' && o.status !== 'received') return false;
      if (statusFilter !== 'all') {
        const k = monthKey(o.date_received || o.date_ordered);
        if (k !== month) return false;
      }
      return true;
    });
  }, [orders, statusFilter, month]);

  async function deleteDraft(o) {
    if (!window.confirm(`Delete draft PO-${o.po_number}? This removes the draft for good.`)) return;
    try {
      await sb.from('fs_order_lines').delete().eq('order_id', o.id);
      await sb.from('fs_orders').delete().eq('id', o.id);
      load();
    } catch (e) { console.warn('delete draft', e); }
  }

  function openPO(id) {
    // open an existing spend PO in FleetStock IN-APP (same window) so the PWA
    // isn't kicked out to a browser tab. Carries login + spend mode.
    try {
      const su = '&shell_user=' + btoa(JSON.stringify(user));
      const lp = locId ? '&loc=' + encodeURIComponent(locId) : '';
      window.location.href = 'https://fleetstock-git-main-fleet-solutions-platform.vercel.app/?po=' + encodeURIComponent(id) + '&mode=spend&origin=outpost' + lp + su;
    } catch { /* noop */ }
  }

  const months = lastNMonths(6);

  return (
    <div style={{ padding: 16, maxWidth: 960, margin: '0 auto' }}>
      {/* header + create button */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Terminal POs</div>
          <div className="muted" style={{ fontSize: 12.5 }}>{loc ? `${loc.code} ${loc.name?.replace(' Terminal', '')}` : ''} · operating-expense purchase orders</div>
        </div>
        <button className="btn" onClick={issueTerminalPO} style={{ fontSize: 14, padding: '11px 20px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 17 }}>+</span> Create PO
        </button>
      </div>

      {/* month selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <select className="input" value={month} onChange={e => { setMonth(e.target.value); setOpenBucket(null); }} style={{ maxWidth: 200 }}>
          {months.map(k => <option key={k} value={k}>{monthLabel(k)}</option>)}
        </select>
      </div>

      {/* spend summary card */}
      <div className="card" style={{ padding: 16, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div className="muted" style={{ fontSize: 11, letterSpacing: '.5px', textTransform: 'uppercase' }}>Posted spend · {monthLabel(month)}</div>
          <div style={{ fontSize: 26, fontWeight: 700 }}>{money(monthTotal)}</div>
        </div>
        {loading ? <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>loading…</div> : buckets.length === 0 ? (
          <div className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>No posted spend this month. Spend appears here once a PO is received.</div>
        ) : (
          <div style={{ marginTop: 12 }}>
            {buckets.map(([name, amt]) => {
              const pct = monthTotal > 0 ? (amt / monthTotal) * 100 : 0;
              const open = openBucket === name;
              const lines = open ? spendRows.filter(r => (catById[r.category_id] || 'Uncategorized') === name) : [];
              return (
                <div key={name} style={{ marginBottom: 8 }}>
                  <div onClick={() => setOpenBucket(open ? null : name)} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 3 }}>
                        <span style={{ fontWeight: 500 }}>{open ? '▾' : '▸'} {name}</span>
                        <span style={{ fontFamily: 'var(--mono, monospace)' }}>{money(amt)}</span>
                      </div>
                      <div style={{ height: 6, background: 'var(--surface2, rgba(0,0,0,.05))', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{ width: pct + '%', height: '100%', background: 'var(--accent)', borderRadius: 4 }} />
                      </div>
                    </div>
                  </div>
                  {open && (
                    <div style={{ marginTop: 6, marginLeft: 14, borderLeft: '2px solid var(--border2, rgba(0,0,0,.12))', paddingLeft: 10 }}>
                      {lines.map(r => (
                        <div key={r.id} onClick={() => r.order_id && openPO(r.order_id)} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0', cursor: r.order_id ? 'pointer' : 'default' }}>
                          <span className="muted">{fmtDate(r.entry_date)} · {(r.description || '').replace(/^PO\s+/, 'PO ').slice(0, 48)}</span>
                          <span style={{ fontFamily: 'var(--mono, monospace)' }}>{money(r.amount)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* draft POs tile — started but not yet issued */}
      {showDraftTile && (
        <div className="card" style={{ padding: 14, marginBottom: 14, border: '1px solid rgba(110,150,240,0.35)', background: 'rgba(110,150,240,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#5a82d8' }}>📝 Draft POs <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>// started but not yet issued</span></div>
            <span className="badge" style={{ background: 'rgba(110,150,240,0.15)', color: '#5a82d8', fontFamily: 'var(--mono, monospace)' }}>{draftOrders.length}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {draftOrders.map(o => (
              <div key={o.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: 'var(--surface, #fff)', borderRadius: 8, padding: '8px 12px' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--mono, monospace)', fontSize: 13, fontWeight: 600 }}>
                    <span style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => openPO(o.id)}>PO-{o.po_number}</span>
                    {o.vendor_name ? <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}> · {o.vendor_name}</span> : <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}> · no vendor yet</span>}
                  </div>
                  <div className="muted" style={{ fontSize: 11 }}>{o.notes || 'draft terminal PO'}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button onClick={() => openPO(o.id)} style={{ fontSize: 11, padding: '5px 11px', borderRadius: 6, cursor: 'pointer', border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 600 }}>complete →</button>
                  <button onClick={() => deleteDraft(o)} title="delete draft" style={{ fontSize: 13, padding: '5px 9px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border2, rgba(0,0,0,.12))', background: 'transparent', color: 'var(--muted, #888)' }}>🗑</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* PO list */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Purchase Orders</div>
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {[['active', 'Open + Draft'], ['open', 'Open'], ['draft', 'Draft'], ['received', 'Received'], ['all', 'All']].map(([v, l]) => (
            <button key={v} onClick={() => setStatusFilter(v)} style={{
              fontFamily: 'var(--mono, monospace)', fontSize: 11, padding: '5px 11px', borderRadius: 6, cursor: 'pointer',
              border: '1px solid var(--border2, rgba(0,0,0,.12))',
              background: statusFilter === v ? 'var(--accent)' : 'transparent',
              color: statusFilter === v ? '#fff' : 'var(--muted, #666)',
            }}>{l}</button>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? <div className="muted" style={{ padding: 16, fontSize: 12 }}>loading…</div> : shownOrders.length === 0 ? (
          <div className="muted" style={{ padding: 16, fontSize: 12.5 }}>
            {statusFilter === 'draft' ? 'Draft POs are shown in the tile above.' : statusFilter === 'open' || statusFilter === 'active' ? 'No open terminal POs this month.' : statusFilter === 'received' ? 'No received terminal POs this month.' : 'No terminal POs yet.'} Tap <b>Create PO</b> to start one.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  {['PO #', 'Vendor', 'Ordered', 'Total', 'Status'].map(h => (
                    <th key={h} style={{ padding: '9px 12px', fontFamily: 'var(--mono, monospace)', fontSize: 10, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--muted2, #999)', borderBottom: '1px solid var(--border2, rgba(0,0,0,.12))', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shownOrders.map(o => (
                  <tr key={o.id} onClick={() => openPO(o.id)} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border, rgba(0,0,0,.06))' }}>
                    <td style={{ padding: '10px 12px', fontFamily: 'var(--mono, monospace)', fontWeight: 600, color: 'var(--accent)' }}>PO-{o.po_number}</td>
                    <td style={{ padding: '10px 12px' }}>{o.vendor_name || '—'}</td>
                    <td style={{ padding: '10px 12px', fontFamily: 'var(--mono, monospace)' }}>{fmtDate(o.date_ordered)}</td>
                    <td style={{ padding: '10px 12px', fontFamily: 'var(--mono, monospace)' }}>{poTotals[o.id] != null ? money(poTotals[o.id]) : money(0)}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <span className="badge" style={{ background: o.status === 'open' ? 'rgba(110,150,240,0.15)' : o.status === 'received' ? 'rgba(120,200,150,0.18)' : 'rgba(0,0,0,.06)', color: o.status === 'open' ? '#5a82d8' : o.status === 'received' ? '#2f9e58' : '#888' }}>{o.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>
        Spend totals reflect <b>posted</b> POs (received → hit the terminal P&amp;L). Open POs are commitments not yet received.
      </div>
    </div>
  );
}

function lastNMonths(n) {
  const out = []; const d = new Date();
  for (let i = 0; i < n; i++) { out.push(monthKey(new Date(d.getFullYear(), d.getMonth() - i, 1))); }
  return out;
}
