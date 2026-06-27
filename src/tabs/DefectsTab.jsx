import React, { useState, useEffect, useRef, useMemo } from 'react';
import { sb } from '../supabase.js';

// Outpost "Defects" tab — driver/tech DVIR write-ups per unit, for the trucks
// assigned to this terminal. Shared table `unit_defects` (one source of truth;
// Shop Command reads/writes the same rows). A defect = one JOB on an RO. From a
// no-shop terminal, turning a defect into a repair always creates/links an
// OUTSIDE RO. Shop terminals don't create ROs here — their shop does that in
// Shop Command — so the create/link actions only show when fullAccess is true.

function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const days = Math.floor((now - d) / 86400000);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (days <= 0) return `today · ${date}`;
  if (days === 1) return `1 day ago · ${date}`;
  return `${days} days ago · ${date}`;
}
function ageDays(ts) {
  if (!ts) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(ts)) / 86400000));
}
function makeRONumber(code, seq) {
  const yy = new Date().getFullYear().toString().slice(-2);
  return `${code}-${String(seq).padStart(4, '0')}${yy}`;
}
function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export default function DefectsTab({ ctx }) {
  const { loc, user, fullAccess, openRO } = ctx;

  const [defects, setDefects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('open'); // 'open' | 'completed'
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  // write-up modal
  const [writeOpen, setWriteOpen] = useState(false);
  // link/create RO modal: { defect }
  const [linkFor, setLinkFor] = useState(null);

  async function load() {
    setLoading(true);
    try {
      let q = sb.from('unit_defects')
        .select('*')
        .eq('location_id', loc.id)
        .order('reported_at', { ascending: false })
        .range(0, 9999);
      if (user.company_id) q = q.eq('company_id', user.company_id);
      const { data, error } = await q;
      if (error) { setErr(error.message); }
      setDefects(data || []);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [loc.id, user.company_id, ctx.roOverlayOpen]);

  const open = useMemo(() => {
    // OOS first, then minor; within each, longest-open (oldest reported) first.
    const list = defects.filter(d => d.status === 'open');
    const rank = s => (s === 'oos' ? 0 : 1);
    return list.sort((a, b) =>
      rank(a.severity) - rank(b.severity) ||
      new Date(a.reported_at) - new Date(b.reported_at)
    );
  }, [defects]);

  const completed = useMemo(() =>
    defects.filter(d => d.status === 'completed')
      .sort((a, b) => new Date(b.completed_at || 0) - new Date(a.completed_at || 0)),
  [defects]);

  const linked = useMemo(() =>
    defects.filter(d => d.status === 'linked')
      .sort((a, b) => {
        const rank = s => (s === 'oos' ? 0 : 1);
        return rank(a.severity) - rank(b.severity) || new Date(a.reported_at) - new Date(b.reported_at);
      }),
  [defects]);

  const oosCount = open.filter(d => d.severity === 'oos').length;

  function flash(setter, text) { setter(text); setTimeout(() => setter(''), 4000); }

  return (
    <div style={{ padding: '20px 16px', maxWidth: 900, margin: '0 auto' }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 700, color: 'var(--text)' }}>Unit Defects</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted2)', marginTop: 2 }}>
            {loc ? `${loc.code} ${loc.name?.replace(' Terminal', '')} · ` : ''}driver &amp; tech DVIR write-ups for units at this terminal
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setWriteOpen(true)} style={{ fontSize: 13, padding: '10px 16px', whiteSpace: 'nowrap' }}>
          + Write up defect
        </button>
      </div>

      {err && <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--accent)', marginBottom: 12, padding: '8px 12px', background: 'rgba(142,0,0,.06)', borderRadius: 6 }}>⚠ {err}</div>}
      {msg && <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--green)', marginBottom: 12, padding: '8px 12px', background: 'var(--green-dim)', borderRadius: 6 }}>✓ {msg}</div>}

      {/* sub-tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid var(--border)' }}>
        {[['open', `Open${open.length ? ` (${open.length})` : ''}`], ['linked', `In repair${linked.length ? ` (${linked.length})` : ''}`], ['completed', 'Completed']].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            padding: '9px 14px', fontSize: 13, fontWeight: tab === id ? 600 : 400,
            color: tab === id ? 'var(--accent)' : 'var(--muted)', background: 'none', border: 'none',
            borderBottom: tab === id ? '2px solid var(--accent)' : '2px solid transparent', cursor: 'pointer',
          }}>{label}</button>
        ))}
      </div>

      {loading && <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted2)', padding: 20 }}>Loading defects…</div>}

      {!loading && tab === 'open' && (
        <>
          {open.length === 0 && (
            <div className="card glow-skip" style={{ padding: 28, textAlign: 'center', color: 'var(--muted)', fontSize: 13.5 }}>
              No open defects at this terminal. 🎉
            </div>
          )}
          {oosCount > 0 && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent)', fontWeight: 600, marginBottom: 10, letterSpacing: '.3px' }}>
              ⛔ {oosCount} OUT OF SERVICE — address first
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {open.map(d => (
              <DefectCard key={d.id} d={d} fullAccess={fullAccess}
                onLink={() => setLinkFor(d)} />
            ))}
          </div>
        </>
      )}

      {!loading && tab === 'linked' && (
        <>
          {linked.length === 0 && (
            <div className="card glow-skip" style={{ padding: 28, textAlign: 'center', color: 'var(--muted)', fontSize: 13.5 }}>
              No defects in repair right now.
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {linked.map(d => (
              <LinkedCard key={d.id} d={d} openRO={openRO} />
            ))}
          </div>
        </>
      )}

      {!loading && tab === 'completed' && (
        <>
          {completed.length === 0 && (
            <div className="card glow-skip" style={{ padding: 28, textAlign: 'center', color: 'var(--muted)', fontSize: 13.5 }}>
              No completed defects yet.
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {completed.map(d => (
              <CompletedCard key={d.id} d={d} openRO={openRO} />
            ))}
          </div>
        </>
      )}

      {writeOpen && (
        <WriteUpModal ctx={ctx}
          onClose={() => setWriteOpen(false)}
          onSaved={() => { setWriteOpen(false); flash(setMsg, 'Defect written up.'); load(); }} />
      )}

      {linkFor && (
        <LinkROModal ctx={ctx} defect={linkFor}
          onClose={() => setLinkFor(null)}
          onLinked={(roNum) => { setLinkFor(null); flash(setMsg, `Defect linked to RO ${roNum}.`); load(); }} />
      )}
    </div>
  );
}

/* ── one open-defect card ───────────────────────────────────────── */
function DefectCard({ d, fullAccess, onLink }) {
  const oos = d.severity === 'oos';
  const age = ageDays(d.reported_at);
  return (
    <div className="card glow-skip" style={{ padding: '14px 16px', borderLeft: `3px solid ${oos ? 'var(--accent)' : 'var(--amber)'}` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 15 }}>{d.unit_number}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, letterSpacing: '.4px', padding: '2px 7px', borderRadius: 4, color: '#fff', background: oos ? 'var(--accent)' : 'var(--amber)' }}>
              {oos ? 'OOS' : 'MINOR'}
            </span>
            {d.source === 'samsara' && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600, padding: '2px 6px', borderRadius: 4, color: 'var(--blue)', background: 'var(--blue-dim)' }}>SAMSARA</span>
            )}
            {age >= 3 && <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: oos ? 'var(--accent)' : 'var(--amber)' }}>{age}d open</span>}
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.4 }}>{d.description}</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted2)', marginTop: 6 }}>
            {d.reported_by_name || 'Unknown'} · {fmtWhen(d.reported_at)}
          </div>
        </div>
        {fullAccess && (
          <button className="btn" onClick={onLink} style={{ flexShrink: 0, fontSize: 12, padding: '8px 14px', border: '1px solid var(--accent)', color: 'var(--accent)', background: 'var(--white)', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
            Create / link RO
          </button>
        )}
      </div>
    </div>
  );
}

/* ── one completed-defect card ──────────────────────────────────── */
function CompletedCard({ d, openRO }) {
  const oos = d.severity === 'oos';
  return (
    <div className="card glow-skip" style={{ padding: '12px 16px', opacity: 0.92 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 14 }}>{d.unit_number}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 4, color: 'var(--muted)', background: 'var(--surface2, rgba(0,0,0,.05))' }}>
              {oos ? 'OOS' : 'MINOR'}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)' }}>✓ completed</span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.4 }}>{d.description}</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted2)', marginTop: 5 }}>
            Completed {d.completed_at ? new Date(d.completed_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''}
            {d.ro_number ? <> · RO <strong style={{ color: 'var(--text)' }}>{d.ro_number}</strong>{d.ro_kind ? ` (${d.ro_kind})` : ''}</> : ''}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── one linked / in-repair defect card ─────────────────────────── */
function LinkedCard({ d, openRO }) {
  const oos = d.severity === 'oos';
  const canOpen = typeof openRO === 'function' && d.ro_number;

  async function openLinkedRO() {
    const table = d.ro_kind === 'outside' ? 'outside_ros' : 'ro_headers';
    const { data } = await sb.from(table).select('*').eq('ro_number', d.ro_number)
      .order('created_at', { ascending: false }).limit(1);
    const row = (data || [])[0];
    if (row) openRO({ ...row, kind: d.ro_kind });
  }

  return (
    <div className="card glow-skip" style={{ padding: '13px 16px', borderLeft: `3px solid var(--blue)` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 15 }}>{d.unit_number}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, letterSpacing: '.4px', padding: '2px 7px', borderRadius: 4, color: '#fff', background: oos ? 'var(--accent)' : 'var(--amber)' }}>
              {oos ? 'OOS' : 'MINOR'}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4, color: 'var(--blue)', background: 'var(--blue-dim)' }}>● in repair</span>
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.4 }}>{d.description}</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted2)', marginTop: 6 }}>
            On RO <strong style={{ color: 'var(--text)' }}>{d.ro_number}</strong>{d.ro_kind ? ` (${d.ro_kind})` : ''} · completes when the RO is finished
          </div>
        </div>
        {canOpen && (
          <button className="btn" onClick={openLinkedRO}
            style={{ flexShrink: 0, fontSize: 12, padding: '8px 14px', border: '1px solid var(--blue)', color: 'var(--blue)', background: 'var(--white)', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
            Open RO
          </button>
        )}
      </div>
    </div>
  );
}

/* ── write-up modal ─────────────────────────────────────────────── */
function WriteUpModal({ ctx, onClose, onSaved }) {
  const { loc, user } = ctx;
  const [unitQuery, setUnitQuery] = useState('');
  const [unitMatches, setUnitMatches] = useState([]);
  const [unitOpen, setUnitOpen] = useState(false);
  const [unitLoading, setUnitLoading] = useState(false);
  const [unit, setUnit] = useState(null);
  const [severity, setSeverity] = useState('minor');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const boxRef = useRef(null);

  useEffect(() => {
    function onDown(e) { if (boxRef.current && !boxRef.current.contains(e.target)) setUnitOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown); };
  }, []);

  async function loadUnits(term) {
    setUnitLoading(true);
    try {
      let q = sb.from('units').select('id,unit_number,unit_type,year,make,model,mileage')
        .eq('location_id', loc.id).order('unit_number').limit(8);
      if (user.company_id) q = q.eq('company_id', user.company_id);
      if (term) q = q.ilike('unit_number', term + '%');
      const { data } = await q;
      setUnitMatches(data || []);
    } finally { setUnitLoading(false); }
  }
  useEffect(() => {
    if (!unitOpen) return;
    let alive = true;
    const t = setTimeout(() => { if (alive) loadUnits(unitQuery.trim()); }, 200);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line
  }, [unitQuery, unitOpen, loc.id, user.company_id]);

  function pickUnit(u) { setUnit(u); setUnitQuery(u.unit_number); setUnitOpen(false); }

  async function save() {
    setErr('');
    if (!unit) { setErr('Pick a unit.'); return; }
    if (!description.trim()) { setErr('Describe the defect.'); return; }
    setSaving(true);
    try {
      const { error } = await sb.from('unit_defects').insert({
        company_id: user.company_id || null,
        unit_id: unit.id,
        unit_number: unit.unit_number,
        location_id: loc.id,
        severity,
        description: description.trim(),
        source: 'manual',
        reported_by: user.id,
        reported_by_name: user.name || user.email || null,
        status: 'open',
      });
      if (error) { setErr(error.message); setSaving(false); return; }
      onSaved();
    } catch (e) { setErr(String(e?.message || e)); setSaving(false); }
  }

  const lbl = { fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginBottom: 6, fontFamily: 'var(--mono)', letterSpacing: '.3px' };

  return (
    <Modal onClose={onClose} title="Write up a defect">
      {/* unit picker */}
      <div style={{ position: 'relative', marginBottom: 16 }} ref={boxRef}>
        <div style={lbl}>Unit <span style={{ color: 'var(--accent)' }}>*</span></div>
        {unit ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '11px 14px', border: '1.5px solid var(--accent)', borderRadius: 'var(--radius-md)', background: 'var(--green-dim)' }}>
            <div>
              <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 15 }}>{unit.unit_number}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>{[unit.year, unit.make, unit.model].filter(Boolean).join(' ') || unit.unit_type}</div>
            </div>
            <button onClick={() => { setUnit(null); setUnitQuery(''); setUnitOpen(true); setTimeout(() => loadUnits(''), 0); }}
              style={{ flexShrink: 0, fontFamily: 'var(--mono)', fontSize: 11, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border2)', background: 'var(--white)', color: 'var(--muted)', cursor: 'pointer' }}>change</button>
          </div>
        ) : (
          <input className="input" style={{ fontSize: 15, padding: '11px 14px' }} placeholder="Type unit number…"
            value={unitQuery}
            onFocus={() => { setUnitOpen(true); loadUnits(unitQuery.trim()); }}
            onChange={e => { setUnitQuery(e.target.value); setUnitOpen(true); }} />
        )}
        {unitOpen && !unit && (
          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, marginTop: 6, maxHeight: 260, overflowY: 'auto', background: 'var(--white)', border: '1px solid var(--border2)', borderRadius: 'var(--radius-md)', boxShadow: '0 12px 32px rgba(0,0,0,.16)' }}>
            {unitLoading && <div style={{ padding: '11px 14px', fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted2)' }}>Searching…</div>}
            {!unitLoading && unitMatches.length === 0 && <div style={{ padding: '11px 14px', fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted2)' }}>No matches at this terminal</div>}
            {!unitLoading && unitMatches.map(u => (
              <div key={u.id} onMouseDown={(e) => { e.preventDefault(); pickUnit(u); }}
                style={{ padding: '11px 14px', cursor: 'pointer', borderBottom: '1px solid var(--border)', fontSize: 13.5 }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--surface2)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{u.unit_number}</span>
                <span style={{ color: 'var(--muted)', marginLeft: 8 }}>{[u.year, u.make, u.model].filter(Boolean).join(' ') || u.unit_type}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* severity */}
      <div style={{ marginBottom: 16 }}>
        <div style={lbl}>Severity <span style={{ color: 'var(--accent)' }}>*</span></div>
        <div style={{ display: 'flex', gap: 8 }}>
          {[['oos', 'Out of service', 'var(--accent)'], ['minor', 'Minor', 'var(--amber)']].map(([val, label, color]) => (
            <button key={val} onClick={() => setSeverity(val)} style={{
              flex: 1, padding: '11px 12px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 600,
              border: severity === val ? `1.5px solid ${color}` : '1px solid var(--border2)',
              color: severity === val ? color : 'var(--muted)',
              background: severity === val ? (val === 'oos' ? 'rgba(142,0,0,.06)' : 'var(--amber-dim)') : 'var(--white)',
            }}>{label}</button>
          ))}
        </div>
      </div>

      {/* description */}
      <div style={{ marginBottom: 18 }}>
        <div style={lbl}>Defect <span style={{ color: 'var(--accent)' }}>*</span></div>
        <textarea className="textarea" style={{ fontSize: 14, padding: '11px 14px', minHeight: 80, resize: 'vertical' }} rows={3}
          placeholder="e.g. Air leak at the trailer gladhand; marker light out; brake adjustment needed"
          value={description} onChange={e => setDescription(e.target.value)} />
      </div>

      {err && <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--accent)', marginBottom: 12, padding: '8px 12px', background: 'rgba(142,0,0,.06)', borderRadius: 6 }}>⚠ {err}</div>}
      <button className="btn btn-primary" onClick={save} disabled={saving} style={{ width: '100%', fontSize: 15, padding: '12px' }}>{saving ? 'Saving…' : 'Write up defect'}</button>
    </Modal>
  );
}

/* ── create / link RO modal (no-shop terminal → outside RO) ─────── */
function LinkROModal({ ctx, defect, onClose, onLinked }) {
  const { loc, user } = ctx;
  const [mode, setMode] = useState('new'); // 'new' | 'existing'
  const [vendors, setVendors] = useState([]);
  const [vendorId, setVendorId] = useState('');
  const [openROs, setOpenROs] = useState([]);
  const [chosenRO, setChosenRO] = useState('');
  const [loadingROs, setLoadingROs] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      const { data } = await sb.from('vendors').select('id,name,city,state').eq('status', 'active').order('name').range(0, 999);
      setVendors(data || []);
    })();
    (async () => {
      setLoadingROs(true);
      try {
        // existing OPEN outside ROs for THIS unit at this terminal
        let q = sb.from('outside_ros')
          .select('id,ro_number,vendor_name,status,date_sent')
          .eq('location_id', loc.id)
          .eq('unit_number', defect.unit_number)
          .not('status', 'in', '(reviewed,closed,denied)')
          .order('ro_number', { ascending: false }).range(0, 99);
        if (user.company_id) q = q.eq('company_id', user.company_id);
        const { data } = await q;
        setOpenROs(data || []);
        if ((data || []).length) { setChosenRO(data[0].id); }
        else { setMode('new'); }
      } finally { setLoadingROs(false); }
    })();
    // eslint-disable-next-line
  }, [defect.unit_number, loc.id, user.company_id]);

  // add the defect as a new JOB on a given outside RO id, then stamp the defect
  async function addJobAndStamp(roId, roNumber) {
    const { data: cur, error: rErr } = await sb.from('ro_jobs').select('job_number').eq('ro_id', roId);
    if (rErr) throw rErr;
    const nextNum = (cur || []).reduce((m, j) => Math.max(m, Number(j.job_number) || 0), 0) + 1;
    const { error: jErr } = await sb.from('ro_jobs').insert({
      ro_id: roId,
      job_number: nextNum,
      complaint: defect.description,
      status: 'not_started',
      ro_kind: 'outside',
    });
    if (jErr) throw jErr;
    const { error: dErr } = await sb.from('unit_defects').update({
      status: 'linked',
      ro_number: roNumber,
      ro_kind: 'outside',
    }).eq('id', defect.id);
    if (dErr) throw dErr;
  }

  async function save() {
    setErr('');
    setSaving(true);
    try {
      if (mode === 'existing') {
        if (!chosenRO) { setErr('Pick an RO.'); setSaving(false); return; }
        const ro = openROs.find(r => r.id === chosenRO);
        await addJobAndStamp(chosenRO, ro.ro_number);
        onLinked(ro.ro_number);
        return;
      }
      // mode === 'new' → create an outside RO header (9500+ band), then add the job
      if (!vendorId) { setErr('Choose a vendor.'); setSaving(false); return; }
      const yy = new Date().getFullYear().toString().slice(-2);
      const { data: existing } = await sb.from('outside_ros')
        .select('ro_number').eq('location_id', loc.id)
        .like('ro_number', `${loc.code}-%${yy}`)
        .order('ro_number', { ascending: false }).limit(1);
      let nextSeq = 9500;
      if (existing && existing.length) {
        const m = existing[0].ro_number.match(/-(\d{4})\d{2}$/);
        if (m) nextSeq = Math.max(9500, parseInt(m[1], 10) + 1);
      }
      const roNum = makeRONumber(loc.code, nextSeq);
      const v = vendors.find(x => x.id === vendorId);
      const { data: inserted, error } = await sb.from('outside_ros').insert({
        ro_number: roNum,
        unit_number: defect.unit_number,
        location_id: loc.id,
        vendor_name: v?.name || '',
        date_sent: todayISO(),
        current_notes: defect.description,
        status: 'inprogress',
        created_by: user.id,
        ...(user.company_id ? { company_id: user.company_id } : {}),
      }).select('id,ro_number').single();
      if (error) { setErr(error.message); setSaving(false); return; }
      await addJobAndStamp(inserted.id, inserted.ro_number);
      onLinked(inserted.ro_number);
    } catch (e) { setErr(String(e?.message || e)); setSaving(false); }
  }

  const lbl = { fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginBottom: 6, fontFamily: 'var(--mono)', letterSpacing: '.3px' };
  const oos = defect.severity === 'oos';

  return (
    <Modal onClose={onClose} title="Turn defect into a repair">
      {/* the defect being addressed */}
      <div style={{ padding: '11px 14px', borderRadius: 'var(--radius-md)', background: oos ? 'rgba(142,0,0,.05)' : 'var(--amber-dim)', border: `1px solid ${oos ? 'var(--accent)' : 'var(--amber)'}`, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 14 }}>{defect.unit_number}</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 4, color: '#fff', background: oos ? 'var(--accent)' : 'var(--amber)' }}>{oos ? 'OOS' : 'MINOR'}</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text)' }}>{defect.description}</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted2)', marginTop: 5 }}>This becomes one job on the RO.</div>
      </div>

      {/* mode toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button onClick={() => setMode('new')} style={{
          flex: 1, padding: '10px 12px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
          border: mode === 'new' ? '1.5px solid var(--accent)' : '1px solid var(--border2)',
          color: mode === 'new' ? 'var(--accent)' : 'var(--muted)', background: mode === 'new' ? 'rgba(142,0,0,.05)' : 'var(--white)',
        }}>New outside RO</button>
        <button onClick={() => setMode('existing')} disabled={!openROs.length} style={{
          flex: 1, padding: '10px 12px', borderRadius: 'var(--radius-md)', cursor: openROs.length ? 'pointer' : 'not-allowed', fontSize: 12.5, fontWeight: 600,
          border: mode === 'existing' ? '1.5px solid var(--accent)' : '1px solid var(--border2)',
          color: !openROs.length ? 'var(--muted2)' : (mode === 'existing' ? 'var(--accent)' : 'var(--muted)'),
          background: mode === 'existing' ? 'rgba(142,0,0,.05)' : 'var(--white)', opacity: openROs.length ? 1 : 0.6,
        }}>
          Add to open RO{openROs.length ? ` (${openROs.length})` : ''}
        </button>
      </div>

      {mode === 'new' && (
        <div style={{ marginBottom: 18 }}>
          <div style={lbl}>Vendor <span style={{ color: 'var(--accent)' }}>*</span></div>
          <select className="select" style={{ fontSize: 14, padding: '11px 14px' }} value={vendorId} onChange={e => setVendorId(e.target.value)}>
            <option value="">Choose a vendor…</option>
            {vendors.map(v => <option key={v.id} value={v.id}>{v.name}{v.city ? ` — ${v.city}, ${v.state}` : ''}</option>)}
          </select>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted2)', marginTop: 8 }}>
            Creates a new outside RO with this defect as job 1. Add cost &amp; details on the RO later.
          </div>
        </div>
      )}

      {mode === 'existing' && (
        <div style={{ marginBottom: 18 }}>
          <div style={lbl}>Open outside RO for {defect.unit_number}</div>
          {loadingROs ? (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted2)', padding: 8 }}>Loading…</div>
          ) : (
            <select className="select" style={{ fontSize: 14, padding: '11px 14px' }} value={chosenRO} onChange={e => setChosenRO(e.target.value)}>
              {openROs.map(r => <option key={r.id} value={r.id}>{r.ro_number}{r.vendor_name ? ` · ${r.vendor_name}` : ''} ({r.status})</option>)}
            </select>
          )}
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted2)', marginTop: 8 }}>
            Adds this defect as another job on the selected RO.
          </div>
        </div>
      )}

      {err && <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--accent)', marginBottom: 12, padding: '8px 12px', background: 'rgba(142,0,0,.06)', borderRadius: 6 }}>⚠ {err}</div>}
      <button className="btn btn-primary" onClick={save} disabled={saving} style={{ width: '100%', fontSize: 15, padding: '12px' }}>
        {saving ? 'Working…' : (mode === 'new' ? 'Create RO & link defect' : 'Add job & link defect')}
      </button>
    </Modal>
  );
}

/* ── tiny modal shell ───────────────────────────────────────────── */
function Modal({ title, onClose, children }) {
  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 16px 16px', overflowY: 'auto' }}>
      <div onMouseDown={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 480, background: 'var(--white)', borderRadius: 'var(--radius-lg)', boxShadow: '0 24px 60px rgba(0,0,0,.3)', padding: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>{title}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--muted)', lineHeight: 1 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
