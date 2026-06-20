import { useState, useEffect, useCallback } from 'react';
import { sb } from '../supabase.js';

const ANDREWS_CO = '00000000-0000-0000-0000-000000000001';
const coScope = (q, user) => (user?.company_id ? q.eq('company_id', user.company_id) : q);

const S = {
  wrap: { padding: 16, maxWidth: 980, margin: '0 auto', fontFamily: 'var(--sans)' },
  card: { background: 'var(--white)', border: '1px solid var(--border2)', borderRadius: 'var(--radius-lg)', marginBottom: 12, boxShadow: 'var(--shadow-sm)', overflow: 'hidden' },
  btn: { background: 'var(--surface2)', border: '1px solid var(--border2)', color: 'var(--text)', padding: '6px 12px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 12, fontFamily: 'var(--mono)' },
  mono: { fontFamily: 'var(--mono)' },
  lbl: { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted2)', textTransform: 'uppercase', letterSpacing: 0.5 },
};

const fmt$ = (n) => '$' + (n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

/* Resolve who approves: location chain row first, else company-wide, else superadmin. */
export function resolveApprover(chains, locationId) {
  const locRow = (chains || []).filter(c => c.location_id === locationId).sort((a, b) => a.step_order - b.step_order)[0];
  const coRow = (chains || []).filter(c => !c.location_id).sort((a, b) => a.step_order - b.step_order)[0];
  return locRow || coRow || { approver_type: 'superadmin' };
}
export function userIsApprover(user, approver) {
  if (user.role === 'superadmin') return true; // superadmin can always act
  if (approver.approver_type === 'role') return user.role === approver.approver_role;
  if (approver.approver_type === 'user') return user.id === approver.approver_user_id;
  return false;
}

export default function ApprovalsTab({ ctx }) {
  const { user, loc, openRO } = ctx;
  const locationId = loc?.id;
  const isSuperAdmin = user.role === 'superadmin';
  const isManager = user.role === 'manager';
  const [jobs, setJobs] = useState([]);
  const [ros, setRos] = useState([]);
  const [chains, setChains] = useState([]);
  const [locations, setLocations] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [denyJob, setDenyJob] = useState(null);
  const [denyNotes, setDenyNotes] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const [jr, cr, lr, ur] = await Promise.all([
      sb.from('ro_jobs').select('*').eq('status', 'waiting').range(0, 49999),
      coScope(sb.from('sc_approval_chains').select('*'), user),
      coScope(sb.from('locations').select('*'), user).order('name'),
      coScope(sb.from('users').select('id,name,email,role,location_id'), user).range(0, 49999),
    ]);
    const waitingAll = jr.data || [];
    // Outpost = OUTSIDE RO approval queue. Keep only outside-kind waiting jobs and
    // join them to outside_ros (not ro_headers). Scope to this terminal.
    const outsideJobs = waitingAll.filter(j => j.ro_kind === 'outside');
    let roRows = [];
    if (outsideJobs.length) {
      const { data } = await sb.from('outside_ros').select('*').in('id', [...new Set(outsideJobs.map(j => j.ro_id))]);
      roRows = (data || []).filter(r => r.location_id === locationId);
    }
    // drop jobs whose RO isn't at this terminal
    const roIds = new Set(roRows.map(r => r.id));
    const waiting = outsideJobs.filter(j => roIds.has(j.ro_id));
    setJobs(waiting); setRos(roRows); setChains(cr.data || []);
    setLocations(lr.data || []); setUsers(ur.data || []);
    setLoading(false);
  }, [user, locationId]);

  useEffect(() => { load(); }, [load]);

  async function approve(job, ro) {
    await sb.from('ro_jobs').update({
      status: 'inprogress', approved: true,
      approved_by: user.id, approved_by_name: user.name || user.email, approved_at: new Date().toISOString(),
    }).eq('id', job.id);
    load();
  }

  async function confirmDeny() {
    const { job, ro } = denyJob;
    await sb.from('ro_jobs').update({
      status: 'denied', denied_by: user.id, denied_by_name: user.name || user.email,
      denied_at: new Date().toISOString(), denial_notes: denyNotes || null,
    }).eq('id', job.id);
    // Close the RO when every job is denied; finished+denied mix goes to review
    const { data: sibs } = await sb.from('ro_jobs').select('status').eq('ro_id', ro.id);
    const all = sibs || [];
    if (all.every(j => j.status === 'denied')) {
      await sb.from('ro_headers').update({ status: 'denied' }).eq('id', ro.id);
    } else if (all.every(j => ['denied', 'finished'].includes(j.status))) {
      await sb.from('ro_headers').update({ status: 'finished', finished_date: new Date().toISOString() }).eq('id', ro.id);
    }
    setDenyJob(null); setDenyNotes(''); load();
  }

  if (loading) return <div style={{ ...S.wrap, ...S.mono, fontSize: 12, color: 'var(--muted2)' }}>loading…</div>;

  // Scope: managers see their location's requests; senior roles see all
  const visible = jobs.map(j => ({ job: j, ro: ros.find(r => r.id === j.ro_id) }))
    .filter(({ ro }) => !!ro)
    .sort((a, b) => (b.job.approval_requested_at || '').localeCompare(a.job.approval_requested_at || ''));

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--page-bg)' }}>
      <div style={S.wrap}>
        <div className="card lh-bigtable" style={{ ...S.card, position: 'relative' }}>
          <div style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ ...S.mono, fontSize: 12, fontWeight: 700 }}>🔏 Pending approvals</span>
            <span style={{ ...S.mono, fontSize: 11, color: 'var(--muted2)' }}>({visible.length})</span>
          </div>
          {!visible.length && <div style={{ ...S.mono, fontSize: 11, color: 'var(--muted2)', padding: 16 }}>No jobs waiting for approval.</div>}
          {visible.length > 0 && <div style={{ padding: 10 }}>
          {visible.map(({ job, ro }) => {
            const approver = resolveApprover(chains, ro.location_id);
            const canAct = userIsApprover(user, approver);
            const approverLabel = approver.approver_type === 'superadmin' ? 'superadmin'
              : approver.approver_type === 'role' ? approver.approver_role
              : (approver.approver_user_name || 'specific user');
            return (
              <div key={job.id} className="card glow-fx" style={{ padding: '12px 14px', marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span onClick={() => openRO && openRO(ro)} style={{ ...S.mono, fontSize: 14, fontWeight: 700, cursor: openRO ? 'pointer' : 'default', textDecoration: openRO ? 'underline' : 'none' }}>#{ro.unit_number}</span>
                  <span style={{ ...S.mono, fontSize: 11, color: 'var(--muted2)' }}>{ro.ro_number} · J{job.job_number} · {locations.find(l => l.id === ro.location_id)?.name || ro.location_id}</span>
                  {job.auto_flagged && <span style={{ ...S.mono, fontSize: 9, padding: '2px 7px', borderRadius: 9, color: 'var(--amber)', background: 'var(--amber-dim)', border: '1px solid var(--amber)' }}>AUTO</span>}
                  <span style={{ ...S.mono, fontSize: 13, fontWeight: 700, color: 'var(--accent)', marginLeft: 'auto' }}>{fmt$(job.estimate_total)}</span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 5 }}>{job.complaint}</div>
                {job.approval_notes && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, fontStyle: 'italic' }}>"{job.approval_notes}"</div>}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
                  <span style={{ ...S.mono, fontSize: 10, color: 'var(--muted2)' }}>
                    requested by {job.approval_requested_by_name || 'system'} · routes to {approverLabel}
                  </span>
                  {canAct && <>
                    <button style={{ ...S.btn, color: 'var(--green)', borderColor: 'var(--green)', marginLeft: 'auto' }} onClick={() => approve(job, ro)}>✓ Approve</button>
                    <button style={{ ...S.btn, color: 'var(--accent)', borderColor: 'var(--accent)' }} onClick={() => { setDenyJob({ job, ro }); setDenyNotes(''); }}>✗ Deny</button>
                  </>}
                </div>
              </div>
            );
          })}
          </div>}
        </div>

        {isSuperAdmin && <ChainConfig user={user} chains={chains} locations={locations} users={users} reload={load} />}

        {denyJob && (
          <div onClick={e => e.target === e.currentTarget && setDenyJob(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 500, padding: 16 }}>
            <div style={{ background: 'var(--white)', border: '1px solid var(--border2)', borderTop: '3px solid var(--accent)', borderRadius: 'var(--radius-lg)', padding: 18, width: '100%', maxWidth: 380, boxShadow: 'var(--shadow-lg)' }}>
              <div style={{ ...S.mono, fontWeight: 700, fontSize: 14, marginBottom: 6 }}>Deny J{denyJob.job.job_number} — #{denyJob.ro.unit_number}?</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>The job is denied. The RO closes once all of its jobs are denied or finished.</div>
              <textarea value={denyNotes} onChange={e => setDenyNotes(e.target.value)} placeholder="Denial notes (why)…" rows={3}
                style={{ width: '100%', background: 'var(--surface3)', border: '1px solid var(--border2)', borderRadius: 'var(--radius-sm)', color: 'var(--text)', padding: 8, fontSize: 13, marginBottom: 12, resize: 'none' }} />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button style={S.btn} onClick={() => setDenyJob(null)}>Cancel</button>
                <button style={{ ...S.btn, background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' }} onClick={confirmDeny}>✗ Deny Job</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── superadmin chain config ──────────────────────────────────── */
function ChainConfig({ user, chains, locations, users, reload }) {
  const [scope, setScope] = useState('');
  const [type, setType] = useState('superadmin');
  const [role, setRole] = useState('mpm');
  const [pickUser, setPickUser] = useState('');

  async function addChain() {
    const target = users.find(u => u.id === pickUser);
    const { error } = await sb.from('sc_approval_chains').insert({
      company_id: user.company_id || ANDREWS_CO,
      location_id: scope || null, step_order: 1,
      approver_type: type,
      approver_role: type === 'role' ? role : null,
      approver_user_id: type === 'user' ? pickUser : null,
      approver_user_name: type === 'user' ? (target?.name || target?.email) : null,
    });
    if (error) { alert(error.message); return; }
    reload();
  }
  async function removeChain(id) {
    await sb.from('sc_approval_chains').delete().eq('id', id); reload();
  }

  return (
    <div style={S.card}>
      <div style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ ...S.mono, fontSize: 12, fontWeight: 700 }}>⚙ Approval routing</span>
        <span style={{ ...S.mono, fontSize: 10, color: 'var(--muted2)', marginLeft: 8 }}>no rule = superadmin · location rules beat company-wide</span>
      </div>
      {chains.map(c => (
        <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 14px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
          <span style={{ ...S.mono, fontSize: 11, fontWeight: 600, width: 160 }}>{c.location_id ? (locations.find(l => l.id === c.location_id)?.name || c.location_id) : 'Company-wide'}</span>
          <span style={{ ...S.mono, fontSize: 11, color: 'var(--muted)' }}>→ {c.approver_type === 'superadmin' ? 'superadmin' : c.approver_type === 'role' ? `role: ${c.approver_role}` : (c.approver_user_name || 'user')}</span>
          <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', marginLeft: 'auto', fontSize: 12 }} onClick={() => removeChain(c.id)}>✕</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, padding: '10px 14px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div><div style={S.lbl}>Scope</div>
          <select style={S.btn} value={scope} onChange={e => setScope(e.target.value)}>
            <option value="">Company-wide</option>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name || l.id}</option>)}
          </select></div>
        <div><div style={S.lbl}>Routes to</div>
          <select style={S.btn} value={type} onChange={e => setType(e.target.value)}>
            <option value="superadmin">Superadmin</option>
            <option value="role">A role</option>
            <option value="user">Specific user</option>
          </select></div>
        {type === 'role' && <div><div style={S.lbl}>Role</div>
          <select style={S.btn} value={role} onChange={e => setRole(e.target.value)}>
            <option value="mpm">mpm (warranty)</option>
            <option value="admin">admin</option>
            <option value="manager">manager</option>
          </select></div>}
        {type === 'user' && <div><div style={S.lbl}>User</div>
          <select style={S.btn} value={pickUser} onChange={e => setPickUser(e.target.value)}>
            <option value="">pick…</option>
            {users.filter(u => u.role !== 'tech' && u.role !== 'vendor').map(u => <option key={u.id} value={u.id}>{u.name || u.email} ({u.role})</option>)}
          </select></div>}
        <button style={{ ...S.btn, background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' }} onClick={addChain} disabled={type === 'user' && !pickUser}>+ add rule</button>
      </div>
    </div>
  );
}
