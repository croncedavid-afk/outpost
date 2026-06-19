import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { sb } from './supabase.js';
import RadarTab from './tabs/RadarTab.jsx';
import UnitsOutTab from './tabs/UnitsOutTab.jsx';
import SendOutTab from './tabs/SendOutTab.jsx';
import ApprovalsTab from './tabs/ApprovalsTab.jsx';
import ROPage from './ROPage.jsx';
import UnitTab from './UnitTab.jsx';

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

  // full-page overlay: open an outside RO or a unit file over the tabs (Back returns)
  // shape: { type: 'ro', ro } | { type: 'unit', unitId }
  const [overlay, setOverlay] = useState(null);
  const openRO = useCallback((ro) => setOverlay({ type: 'ro', ro }), []);
  const openUnit = useCallback((unitId) => setOverlay({ type: 'unit', unitId }), []);
  const closeOverlay = useCallback(() => setOverlay(null), []);

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
          // exclude the logical 'shared_fleet' bucket from the selector
          const list = (locs || []).filter(l => l.id !== 'shared_fleet').map(l => ({ ...l, service_model: sm[l.id] || null }));
          if (alive) {
            setPickList(list);
            // default to the first terminal so there's no landing wall; dropdown lets them switch
            if (list.length) { setPickedId(list[0].id); }
            else { setLoc(null); setLocLoading(false); }
          }
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
  const readOnly = !fullAccess;
  const ctx = { user, loc, serviceModel, fullAccess, isOwnerLevel, setActiveTab, openRO, openUnit, readOnly };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--page-bg)' }}>
      {/* top bar */}
      <div style={{ background: 'var(--nav-bg)', color: 'var(--nav-text)', padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 18 }}>📡</span>
        <span style={{ fontWeight: 600, fontSize: 15 }}>Outpost</span>
        {loc && isOwnerLevel && pickList && pickList.length > 0 ? (
          <select
            value={pickedId || loc.id}
            onChange={e => { setLoc(null); setServiceModel(null); setLocLoading(true); setPickedId(e.target.value); }}
            style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 500, padding: '4px 8px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.10)', color: '#fff', border: '1px solid rgba(255,255,255,0.20)', cursor: 'pointer' }}
            title="Switch terminal"
          >
            {pickList.map(t => (
              <option key={t.id} value={t.id} style={{ color: '#111' }}>{t.code} {t.name?.replace(' Terminal', '')}{t.service_model === 'vendor_based' ? ' (vendor)' : ''}</option>
            ))}
          </select>
        ) : loc && (
          <span className="badge" style={{ background: 'rgba(120,200,150,0.15)', color: '#7fdcab' }}>{loc.code} {loc.name?.replace(' Terminal', '')}</span>
        )}
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

      {/* full-page overlay (outside RO or unit file) — sits over the tabs */}
      {overlay && loc && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'var(--page-bg)', overflow: 'auto' }}>
          <div style={{ background: 'var(--nav-bg)', color: 'var(--nav-text)', padding: '9px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <button className="btn btn-sm" onClick={closeOverlay} style={{ background: 'rgba(255,255,255,0.10)', color: '#fff', border: '1px solid rgba(255,255,255,0.20)' }}>← Back</button>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{overlay.type === 'ro' ? 'Outside Repair Order' : 'Unit File'}</span>
            {readOnly && <span className="badge" style={{ background: 'rgba(255,255,255,0.10)', color: '#bbb' }}>read-only</span>}
          </div>
          {overlay.type === 'ro' ? (
            <ROPage
              ro={overlay.ro}
              user={user}
              isTech={false}
              readOnly={readOnly}
              kind="outside"
              onBack={closeOverlay}
            />
          ) : (
            <UnitTab
              user={user}
              locationId={loc.id}
              deepUnitId={overlay.unitId}
              readOnly={readOnly}
              onOpenUnit={openUnit}
              onDeepConsumed={() => {}}
            />
          )}
        </div>
      )}

      {/* body */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {locLoading ? <div className="loading">Loading terminal…</div> : !loc ? (
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

