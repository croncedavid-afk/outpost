import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { sb } from './supabase.js';
import RadarTab from './tabs/RadarTab.jsx';
import UnitsOutTab from './tabs/UnitsOutTab.jsx';
import SendOutTab from './tabs/SendOutTab.jsx';
import ApprovalsTab from './tabs/ApprovalsTab.jsx';

// ── Auth: shell handoff (read synchronously before first render) ──
function readInitialUser() {
  try {
    const params = new URLSearchParams(window.location.search);
    const encoded = params.get('shell_user');
    if (encoded) {
      const u = JSON.parse(atob(encoded));
      sessionStorage.setItem('al_session_user', JSON.stringify(u));
      window.history.replaceState({}, '', window.location.pathname);
      return u;
    }
  } catch {}
  try { return JSON.parse(sessionStorage.getItem('al_session_user')); } catch { return null; }
}

const ROLES_ALLOWED = ['terminal_manager', 'manager', 'director', 'vp', 'superadmin', 'admin', 'business', 'regional_manager'];

const TABS = [
  { id: 'radar', label: 'Radar', icon: 'M' },
  { id: 'units_out', label: 'Units Out', icon: 'U' },
  { id: 'send_out', label: 'Send Out', icon: 'S' },
  { id: 'approvals', label: 'Approvals', icon: 'A' },
];

export default function App() {
  const [user, setUser] = useState(readInitialUser);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPw, setLoginPw] = useState('');
  const [loginErr, setLoginErr] = useState('');
  const [activeTab, setActiveTab] = useState('radar');
  const [loc, setLoc] = useState(null);          // { id, code, name }
  const [serviceModel, setServiceModel] = useState(null); // 'vendor_based' | 'in_house_shop' | null
  const [locLoading, setLocLoading] = useState(true);
  const [pickList, setPickList] = useState(null); // owner-level: [{id,code,name,service_model}] to choose from
  const [pickedId, setPickedId] = useState(null); // owner-level chosen terminal id

  // apply saved theme + accent
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      try {
        const { data } = await sb.from('user_preferences')
          .select('preference_key,preference_value').eq('user_id', user.id);
        (data || []).forEach(row => {
          if (row.preference_key === 'colors' && row.preference_value?.accent) {
            document.documentElement.style.setProperty('--accent', row.preference_value.accent);
          }
          if (row.preference_key === 'theme' && row.preference_value?.mode) {
            document.documentElement.setAttribute('data-theme', row.preference_value.mode);
          }
        });
      } catch {}
    })();
  }, [user?.id]);

  // platform-owner / multi-location roles can pick any terminal
  const isOwnerLevel = ['business', 'superadmin', 'admin', 'vp', 'director', 'regional_manager'].includes(user?.role);

  // resolve the active terminal + its service_model (the two-tier gate).
  // Priority: owner-picked terminal -> user's own location_id -> (owner) show a picker.
  useEffect(() => {
    if (!user) { setLocLoading(false); return; }
    let alive = true;
    (async () => {
      setLocLoading(true);
      const activeId = pickedId || user.location_id || null;
      if (!activeId) {
        // No terminal on the account. Owner-level users pick one; everyone else gets the no-terminal message.
        if (isOwnerLevel) {
          const { data: locs } = await sb.from('locations').select('id,code,name').eq('company_id', user.company_id).order('code');
          const ids = (locs || []).map(l => l.id);
          let sm = {};
          if (ids.length) {
            const { data: profs } = await sb.from('location_profiles').select('location_id,service_model').in('location_id', ids);
            (profs || []).forEach(p => { sm[p.location_id] = p.service_model; });
          }
          // exclude the logical 'shared_fleet' bucket from the picker
          const list = (locs || []).filter(l => l.id !== 'shared_fleet').map(l => ({ ...l, service_model: sm[l.id] || null }));
          if (alive) { setPickList(list); setLoc(null); setLocLoading(false); }
        } else {
          if (alive) { setLoc(null); setLocLoading(false); }
        }
        return;
      }
      const [{ data: l }, { data: p }] = await Promise.all([
        sb.from('locations').select('id,code,name').eq('id', activeId).maybeSingle(),
        sb.from('location_profiles').select('service_model,complexity_rating').eq('location_id', activeId).maybeSingle(),
      ]);
      if (!alive) return;
      if (l) setLoc(l);
      setServiceModel(p?.service_model || null);
      setLocLoading(false);
    })();
    return () => { alive = false; };
  }, [user?.location_id, pickedId, user, isOwnerLevel]);

  async function doLogin() {
    setLoginErr('');
    const email = loginEmail.trim();
    if (!email || !loginPw) { setLoginErr('Enter email and password.'); return; }
    try {
      const { data } = await sb.from('users').select('*').ilike('email', email).maybeSingle();
      if (!data) { setLoginErr('No account found for that email.'); return; }
      if ((data.password || '') !== loginPw) { setLoginErr('Incorrect password.'); return; }
      sessionStorage.setItem('al_session_user', JSON.stringify(data));
      setUser(data);
    } catch (e) { setLoginErr('Login failed: ' + String(e?.message || e)); }
  }
  function logout() {
    sessionStorage.removeItem('al_session_user');
    setUser(null);
  }

  // ── Login screen (direct access only) ──
  if (!user) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--page-bg)', padding: 20 }}>
        <div className="card" style={{ width: 360, padding: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <span style={{ fontSize: 22 }}>📡</span>
            <h1 style={{ fontSize: 20, fontWeight: 600 }}>Outpost</h1>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 20 }}>Terminal maintenance command</p>
          <input className="input" placeholder="Email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} style={{ marginBottom: 10 }} />
          <input className="input" type="password" placeholder="Password" value={loginPw} onChange={e => setLoginPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && doLogin()} style={{ marginBottom: 14 }} />
          {loginErr && <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent)', marginBottom: 12 }}>⚠ {loginErr}</div>}
          <button className="btn btn-primary" onClick={doLogin} style={{ width: '100%' }}>Sign in</button>
        </div>
      </div>
    );
  }

  // ── Role gate ──
  if (!ROLES_ALLOWED.includes(user.role)) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <div className="card" style={{ padding: 28, maxWidth: 400, textAlign: 'center' }}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>🔒</div>
          <h2 style={{ fontSize: 17, marginBottom: 8 }}>Outpost isn't available for your role</h2>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>Outpost is for terminal managers and leadership. If you think this is a mistake, contact your administrator.</p>
          <button className="btn" onClick={logout}>Sign out</button>
        </div>
      </div>
    );
  }

  // full access only at vendor-based terminals; everyone else is read-only
  const fullAccess = serviceModel === 'vendor_based';
  const ctx = { user, loc, serviceModel, fullAccess, isOwnerLevel, setActiveTab };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--page-bg)' }}>
      {/* top bar */}
      <div style={{ background: 'var(--nav-bg)', color: 'var(--nav-text)', padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 18 }}>📡</span>
        <span style={{ fontWeight: 600, fontSize: 15 }}>Outpost</span>
        {loc && <span className="badge" style={{ background: 'rgba(120,200,150,0.15)', color: '#7fdcab' }}>{loc.code} {loc.name?.replace(' Terminal', '')}</span>}
        {loc && isOwnerLevel && <button className="btn btn-sm" onClick={() => { setPickedId(null); setLoc(null); setServiceModel(null); }} style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.18)', padding: '3px 9px' }}>Switch terminal</button>}
        {!locLoading && (
          fullAccess
            ? <span className="badge" style={{ background: 'rgba(110,150,240,0.15)', color: '#9cc2ff' }}>vendor-based · full access</span>
            : <span className="badge" style={{ background: 'rgba(255,255,255,0.10)', color: '#bbb' }}>read-only · managed by shop</span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.7 }}>{user.name || user.email} · {(user.role || '').replace(/_/g, ' ')}</span>
        <button className="btn btn-sm" onClick={logout} style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.18)' }}>Sign out</button>
      </div>

      {/* tab bar */}
      <div style={{ background: 'var(--white)', borderBottom: '1px solid var(--border)', padding: '0 12px', display: 'flex', gap: 2, overflowX: 'auto' }}>
        {TABS.map(t => {
          // hide Send Out + Approvals when read-only (managed-by-shop terminals)
          if (!fullAccess && (t.id === 'send_out' || t.id === 'approvals')) return null;
          const on = activeTab === t.id;
          return (
            <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
              padding: '12px 16px', fontSize: 13, fontWeight: on ? 600 : 400,
              color: on ? 'var(--accent)' : 'var(--muted)', background: 'none', border: 'none',
              borderBottom: on ? '2px solid var(--accent)' : '2px solid transparent',
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}>{t.label}</button>
          );
        })}
      </div>

      {/* body */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {locLoading ? <div className="loading">Loading terminal…</div> : (!loc && pickList) ? (
          <div style={{ padding: 24, maxWidth: 560, margin: '0 auto' }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)', textTransform: 'uppercase', marginBottom: 10 }}>Choose a terminal</div>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>Your account oversees the whole fleet, so pick which terminal's Outpost to view.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {pickList.map(t => (
                <button key={t.id} onClick={() => setPickedId(t.id)} className="card" style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', textAlign: 'left', border: '1px solid var(--border)' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 14, minWidth: 50 }}>{t.code}</span>
                  <span style={{ fontSize: 13, flex: 1 }}>{t.name}</span>
                  {t.service_model === 'vendor_based'
                    ? <span className="badge badge-blue">vendor-based</span>
                    : t.service_model === 'in_house_shop'
                    ? <span className="badge badge-muted">in-house shop</span>
                    : <span className="badge badge-muted">unset</span>}
                </button>
              ))}
            </div>
          </div>
        ) : !loc ? (
          <div className="loading">No terminal is linked to your account. Contact your administrator.</div>
        ) : (
          <>
            {activeTab === 'radar' && <RadarTab ctx={ctx} />}
            {activeTab === 'units_out' && <UnitsOutTab ctx={ctx} />}
            {activeTab === 'send_out' && fullAccess && <SendOutTab ctx={ctx} />}
            {activeTab === 'approvals' && fullAccess && <ApprovalsTab ctx={ctx} />}
          </>
        )}
      </div>
    </div>
  );
}
