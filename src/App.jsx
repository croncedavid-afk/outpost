import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { sb } from './supabase.js';
import RadarTab from './tabs/RadarTab.jsx';
import UnitsOutTab from './tabs/UnitsOutTab.jsx';
import SendOutTab from './tabs/SendOutTab.jsx';
import ApprovalsTab from './tabs/ApprovalsTab.jsx';
import ROPage from './ROPage.jsx';
import UnitTab from './UnitTab.jsx';
import ThemeSettings, { initTheme } from './components/ThemeSettings.jsx';

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
// Roles that may see + act on the Approvals tab (dispatcher excluded).
const APPROVER_ROLES = ['manager', 'terminal_manager', 'director', 'vp', 'admin', 'superadmin'];

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
  const [showTheme, setShowTheme] = useState(false);
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

  // apply saved theme + accent via the shared platform component (appKey 'op')
  useEffect(() => {
    if (!user?.id) return;
    initTheme(sb, user.id, 'op');
  }, [user?.id]);

  // ---- Focus FX: hover on desktop, screen-center on touch ----
  // Cards (bubbles): lift + glow + two-chaser snake + 8% grow.
  // Big tables (.lh-bigtable): rail + truck convoy + dust trail on the active row.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const TILE = 24;
    const isTouch = !!(window.matchMedia && window.matchMedia('(pointer:coarse)').matches);

    function ensureOverlays(card) {
      if (card.__lhFx) return card.__lhFx;
      const mk = (cls) => { const d = document.createElement('div'); d.className = 'lh-fx ' + cls; card.appendChild(d); return d; };
      const fx = { rail: mk('lh-fx-rail'), dust: mk('lh-fx-dust'), convoy: mk('lh-fx-convoy') };
      card.__lhFx = fx; return fx;
    }
    function positionRow(card, row) {
      const fx = ensureOverlays(card);
      const rows = card.querySelectorAll('tbody tr');
      rows.forEach((r) => r.classList.toggle('lh-row-center', r === row));
      if (row) {
        const cb = card.getBoundingClientRect(); const rb = row.getBoundingClientRect();
        const top = rb.top - cb.top + card.scrollTop; const h = rb.height; const y = (top + h - TILE) + 'px';
        fx.rail.style.top = top + 'px'; fx.rail.style.height = h + 'px'; fx.rail.classList.add('show');
        fx.convoy.style.top = y; fx.convoy.classList.add('show');
        fx.dust.style.top = y; fx.dust.classList.add('show');
      } else {
        fx.rail.classList.remove('show'); fx.convoy.classList.remove('show'); fx.dust.classList.remove('show');
      }
    }
    function clearRows() { document.querySelectorAll('.lh-bigtable').forEach((card) => positionRow(card, null)); }
    function markCards() {
      document.querySelectorAll('.card').forEach((c) => { if (!c.classList.contains('lh-bigtable')) c.classList.add('glow-fx'); });
    }

    let cleanupFns = [];

    if (isTouch) {
      // ---------- TOUCH: screen-center target ----------
      function run() {
        markCards();
        const mid = window.innerHeight / 2;
        const cards = Array.from(document.querySelectorAll('.card')).filter((c) => !c.classList.contains('lh-bigtable'));
        const cand = cards.map((c) => ({ c, b: c.getBoundingClientRect() }))
          .filter(({ b }) => b.height > 0 && b.bottom > 110 && b.top < window.innerHeight - 70);

        let chosen = null;
        // cards the screen-center line passes through = the "current row"
        const straddlers = cand.filter(({ b }) => b.top <= mid && b.bottom >= mid);
        if (straddlers.length) {
          straddlers.sort((p, q) =>
            Math.abs((p.b.top + p.b.height / 2) - mid) - Math.abs((q.b.top + q.b.height / 2) - mid));
          const anchor = straddlers[0];
          // side-by-side tiles sharing the anchor's row: left lights first, hands off to right past halfway
          const rowCards = straddlers.filter(({ b }) => {
            const overlap = Math.min(b.bottom, anchor.b.bottom) - Math.max(b.top, anchor.b.top);
            return overlap > Math.min(b.height, anchor.b.height) * 0.5;
          });
          rowCards.sort((p, q) => p.b.left - q.b.left);
          const top = Math.min(...rowCards.map((r) => r.b.top));
          const bot = Math.max(...rowCards.map((r) => r.b.bottom));
          let frac = (mid - top) / Math.max(1, bot - top);
          frac = Math.max(0, Math.min(0.999, frac));
          const idx = Math.min(rowCards.length - 1, Math.floor(frac * rowCards.length));
          chosen = rowCards[idx].c;
        } else if (cand.length) {
          let bcd = Infinity;
          for (const { c, b } of cand) {
            const d = Math.abs((b.top + b.height / 2) - mid);
            if (d < bcd) { bcd = d; chosen = c; }
          }
        }
        cards.forEach((c) => c.classList.toggle('glow-center', c === chosen));

        // big tables: roll the convoy onto the screen-centered row
        document.querySelectorAll('.lh-bigtable').forEach((card) => {
          const rows = card.querySelectorAll('tbody tr');
          let br = null, brd = Infinity;
          rows.forEach((r) => {
            const b = r.getBoundingClientRect(); const cc = b.top + b.height / 2; const d = Math.abs(cc - mid);
            if (cc > 110 && cc < window.innerHeight - 70 && d < brd) { brd = d; br = r; }
          });
          positionRow(card, br);
        });
      }
      let raf = 0;
      const onScroll = () => { if (raf) return; raf = requestAnimationFrame(() => { run(); raf = 0; }); };
      window.addEventListener('scroll', onScroll, { passive: true, capture: true });
      window.addEventListener('resize', onScroll);
      const mo = new MutationObserver(onScroll); mo.observe(document.body, { childList: true, subtree: true });
      const t1 = setTimeout(run, 60); const t2 = setTimeout(run, 300); run();
      cleanupFns.push(() => {
        window.removeEventListener('scroll', onScroll, { capture: true });
        window.removeEventListener('resize', onScroll); mo.disconnect();
        clearTimeout(t1); clearTimeout(t2);
      });
    } else {
      // ---------- DESKTOP: the mouse is the target (hover) ----------
      function onOver(e) {
        markCards();
        const card = e.target.closest && e.target.closest('.card');
        const bigCard = card && card.classList.contains('lh-bigtable') ? card : (e.target.closest && e.target.closest('.lh-bigtable'));
        document.querySelectorAll('.card.glow-center').forEach((c) => { if (c !== card) c.classList.remove('glow-center'); });
        if (card && !card.classList.contains('lh-bigtable')) card.classList.add('glow-center');
        if (bigCard) { const row = e.target.closest && e.target.closest('tbody tr'); if (row && bigCard.contains(row)) positionRow(bigCard, row); }
      }
      function onLeaveDoc(e) {
        const toEl = e.relatedTarget;
        document.querySelectorAll('.card.glow-center').forEach((c) => { if (!toEl || !c.contains(toEl)) c.classList.remove('glow-center'); });
        document.querySelectorAll('.lh-bigtable').forEach((card) => { if (!toEl || !card.contains(toEl)) positionRow(card, null); });
      }
      document.addEventListener('mouseover', onOver);
      document.addEventListener('mouseout', onLeaveDoc);
      const mo = new MutationObserver(() => markCards()); mo.observe(document.body, { childList: true, subtree: true });
      const t1 = setTimeout(markCards, 60); markCards(); clearRows();
      cleanupFns.push(() => {
        document.removeEventListener('mouseover', onOver);
        document.removeEventListener('mouseout', onLeaveDoc);
        mo.disconnect(); clearTimeout(t1);
      });
    }

    return () => { cleanupFns.forEach((fn) => fn()); };
  }, [user?.id, activeTab, overlay]);  // re-bind when tab/overlay changes so new cards are covered

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
  const canApprove = APPROVER_ROLES.includes(user.role);
  const ctx = { user, loc, serviceModel, fullAccess, isOwnerLevel, setActiveTab, openRO, openUnit, readOnly, canApprove };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--page-bg)' }}>
      {showTheme && <ThemeSettings sb={sb} user={user} appKey="op" onClose={() => setShowTheme(false)} />}
      {/* top bar */}
      <div id="op-nav" style={{ background: 'var(--nav-bg)', color: 'var(--nav-text)', padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
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
        <button className="sc-nav-btn" onClick={() => setShowTheme(true)} title="Theme & accent">🎨 theme</button>
        <button className="sc-nav-btn" onClick={logout}>sign out</button>
      </div>

      {/* tab bar */}
      <div id="op-tabs" style={{ background: 'var(--white)', borderBottom: '1px solid var(--border)', padding: '0 12px', display: 'flex', gap: 2, overflowX: 'auto' }}>
        {TABS.map(t => {
          // hide Send Out + Approvals when read-only (managed-by-shop terminals)
          if (!fullAccess && (t.id === 'send_out' || t.id === 'approvals')) return null;
          // Approvals is only for approver roles (dispatcher excluded)
          if (t.id === 'approvals' && !canApprove) return null;
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
            {activeTab === 'approvals' && fullAccess && canApprove && <ApprovalsTab ctx={ctx} />}
          </>
        )}
      </div>
    </div>
  );
}

