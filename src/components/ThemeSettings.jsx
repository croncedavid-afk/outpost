import React, { useState, useEffect } from 'react';

/* ════════════════════════════════════════════════════════════
   SHARED THEME SETTINGS — platform standard (mirrors dashboard)
   Drop into any app. Props: sb, user, onClose, appKey ('sc','lp','ts','pmq','wp','vd')
   - Accent color saves to user_preferences key `colors_<appKey>`
   - Theme mode saves to shared key `theme` → follows user across ALL apps
     modes: 'auto' | 'light' | 'dark' | 'sun'   (older apps fall back to light
     on any mode they do not recognise)
   ════════════════════════════════════════════════════════════ */

/* Accent is the ONLY customisable color now. Other surface vars are theme-driven. */
const ACCENT = { id: 'accent', css: '--accent', def: '#8e0000' };

const lsKey = (appKey, id) => `${appKey}_${id}`;

/* ── Accent swatch palette ── */
const DEEP_SWATCHES = [
  '#8e0000', '#b91c1c', '#c2410c', '#a16207', '#15803d', '#0f766e',
  '#1d4ed8', '#4338ca', '#6d28d9', '#a21caf', '#be185d',
];
const PASTEL_SWATCHES = [
  '#f4978e', '#f8ad9d', '#fbc4ab', '#ffdac1', '#b5e2c0', '#a0e7e5',
  '#a9d6f5', '#b8b8f0', '#d4b8f0', '#f0b8e4', '#f7d6e0',
];

/* ── theme mode helpers ── */
function prefersDark() {
  try { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }
  catch (e) { return false; }
}
function prefersHighContrast() {
  try { return window.matchMedia && window.matchMedia('(prefers-contrast: more)').matches; }
  catch (e) { return false; }
}
/* time-of-day fallback when the OS gives no colour-scheme hint: dark 7pm–6am */
function isNightHour() {
  const h = new Date().getHours();
  return h >= 19 || h < 6;
}
/* Resolve a stored mode → the concrete look to paint: 'light' | 'dark' | 'sun' */
function resolveMode(mode) {
  if (mode === 'sun') return 'sun';
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  // 'auto' (or anything unknown): obey OS, then time of day; honour contrast pref
  if (prefersHighContrast()) return 'sun';
  if (prefersDark()) return 'dark';
  if (isNightHour()) return 'dark';
  return 'light';
}

export function emberSync() {
  const acc = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  if (!acc || acc.charAt(0) !== '#') return;
  let hex = acc.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (hex.length !== 6) return;
  const r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255, b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0); else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60;
  }
  const h2 = (h + 38) % 360, s2 = Math.min(s * 100 + 18, 100), l2 = Math.min(Math.max(l * 100 + 26, 48), 68);
  document.documentElement.style.setProperty('--accent2', `hsl(${h2.toFixed(0)},${s2.toFixed(0)}%,${l2.toFixed(0)}%)`);
  document.documentElement.style.setProperty('--accent-glow', `0 4px 20px hsla(${h.toFixed(0)},${(s * 100).toFixed(0)}%,${(l * 100).toFixed(0)}%,0.5)`);
}

export function applyColorVar(target, color) {
  document.documentElement.style.setProperty(target.css, color);
  if (target.id === 'accent') emberSync();
}

/* applyTheme — accepts a stored MODE ('auto'|'light'|'dark'|'sun').
   Resolves it to a concrete look and sets data-theme + data-contrast.
   Signature unchanged (single string arg) so existing callers keep working. */
export function applyTheme(mode) {
  const look = resolveMode(mode);
  // data-theme drives the green dark palette; 'sun' is light + high-contrast
  if (look === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.removeAttribute('data-contrast');
    // dark surfaces must beat any stale custom light overrides (legacy keys)
    document.documentElement.style.removeProperty('--page-bg');
    document.documentElement.style.removeProperty('--text');
    document.documentElement.style.removeProperty('--muted2');
    document.documentElement.style.removeProperty('--nav-bg');
    document.documentElement.style.removeProperty('--nav-text');
  } else if (look === 'sun') {
    document.documentElement.setAttribute('data-theme', 'light');
    document.documentElement.setAttribute('data-contrast', 'high');
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
    document.documentElement.removeAttribute('data-contrast');
  }
  localStorage.setItem('al_theme', mode);
}

export function applyStoredColors(appKey) {
  const saved = localStorage.getItem(lsKey(appKey, 'accent'));
  if (saved) applyColorVar(ACCENT, saved);
  applyTheme(localStorage.getItem('al_theme') || 'auto');
}

/* Call once after login. Loads colors_<appKey> + shared theme from Supabase,
   hydrates localStorage, applies. */
export async function initTheme(sb, userId, appKey) {
  applyStoredColors(appKey); // instant paint from cache
  emberSync();
  if (!userId || !sb) return;
  try {
    const { data } = await sb.from('user_preferences')
      .select('preference_key,preference_value')
      .eq('user_id', userId)
      .in('preference_key', [`colors_${appKey}`, 'theme']);
    (data || []).forEach(row => {
      if (row.preference_key === `colors_${appKey}` && row.preference_value) {
        Object.entries(row.preference_value).forEach(([k, v]) => {
          if (typeof v === 'string') localStorage.setItem(k, v);
        });
      }
      if (row.preference_key === 'theme' && row.preference_value?.mode) {
        localStorage.setItem('al_theme', row.preference_value.mode);
      }
    });
    applyStoredColors(appKey); // re-apply with fresh values
    emberSync();
  } catch (e) { /* offline: cache already applied */ }
}

/* relative luminance → choose readable text on a swatch preview */
function isLightColor(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return false;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return (r * 0.299 + g * 0.587 + b * 0.114) > 150;
}

const THEME_OPTS = [
  { id: 'auto',  label: 'Auto',     icon: '🪄', hint: 'match device & time' },
  { id: 'light', label: 'Day',      icon: '☀️', hint: 'light, matches other apps' },
  { id: 'dark',  label: 'Night',    icon: '🌙', hint: 'green control room' },
  { id: 'sun',   label: 'Sunlight', icon: '🔆', hint: 'high-contrast outdoors' },
];

export default function ThemeSettings({ sb, user, onClose, appKey }) {
  const [mode, setMode] = useState(() => localStorage.getItem('al_theme') || 'auto');
  const [accent, setAccent] = useState(() => localStorage.getItem(lsKey(appKey, 'accent')) || ACCENT.def);
  const mono = { fontFamily: 'var(--mono)' };

  useEffect(() => {
    setAccent(localStorage.getItem(lsKey(appKey, 'accent')) || ACCENT.def);
  }, [appKey]);

  async function pickTheme(next) {
    setMode(next);
    applyTheme(next);
    if (next === 'light' || next === 'sun') applyStoredColors(appKey);
    emberSync();
    if (user?.id) {
      try {
        await sb.from('user_preferences').upsert({
          user_id: user.id, preference_key: 'theme',
          preference_value: { mode: next }, updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,preference_key' });
      } catch (e) { console.warn('theme save failed', e); }
    }
  }

  async function pickAccent(hex) {
    setAccent(hex);
    localStorage.setItem(lsKey(appKey, 'accent'), hex);
    applyColorVar(ACCENT, hex);
    if (user?.id) {
      try {
        await sb.from('user_preferences').upsert({
          user_id: user.id, preference_key: `colors_${appKey}`,
          preference_value: { [lsKey(appKey, 'accent')]: hex },
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,preference_key' });
      } catch (e) { console.warn('accent save failed', e); }
    }
  }

  async function resetAccent() {
    setAccent(ACCENT.def);
    localStorage.removeItem(lsKey(appKey, 'accent'));
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--accent2');
    applyColorVar(ACCENT, ACCENT.def);
    if (user?.id) {
      try {
        await sb.from('user_preferences').upsert({
          user_id: user.id, preference_key: `colors_${appKey}`,
          preference_value: {}, updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,preference_key' });
      } catch (e) {}
    }
  }

  const swatch = (hex) => {
    const on = accent.toLowerCase() === hex.toLowerCase();
    return (
      <button key={hex} onClick={() => pickAccent(hex)} title={hex}
        style={{
          width: 28, height: 28, borderRadius: '50%', cursor: 'pointer', padding: 0,
          background: hex, flexShrink: 0,
          border: on ? '2px solid var(--text)' : '2px solid transparent',
          boxShadow: on ? '0 0 0 2px var(--white), 0 0 0 4px var(--accent)' : '0 1px 4px rgba(0,0,0,.25)',
          transition: 'transform .1s',
        }} />
    );
  };

  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--white, var(--card-bg, #fff))', borderRadius: 'var(--radius-lg, 12px)', width: '100%', maxWidth: 380, maxHeight: '90vh', overflowY: 'auto', boxShadow: 'var(--shadow-lg)', border: '1px solid var(--border)' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ ...mono, fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Appearance</span>
          <button onClick={onClose} style={{ ...mono, background: 'none', border: 'none', color: 'var(--muted2)', cursor: 'pointer', fontSize: 14 }}>✕</button>
        </div>
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 18 }}>

          {/* Theme */}
          <div>
            <div style={{ ...mono, fontSize: 10, color: 'var(--muted2)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 8 }}>theme</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {THEME_OPTS.map(opt => {
                const on = mode === opt.id;
                return (
                  <button key={opt.id} onClick={() => pickTheme(opt.id)}
                    style={{
                      ...mono, fontSize: 12, padding: '8px 10px', borderRadius: 'var(--radius-sm, 6px)',
                      cursor: 'pointer', textAlign: 'left', lineHeight: 1.25,
                      border: `1px solid ${on ? 'var(--accent)' : 'var(--border2)'}`,
                      background: on ? 'var(--red-dim, rgba(142,0,0,.07))' : 'transparent',
                      color: on ? 'var(--accent)' : 'var(--text)',
                    }}>
                    <div>{opt.icon} {opt.label}</div>
                    <div style={{ fontSize: 8, color: 'var(--muted2)', marginTop: 2 }}>{opt.hint}</div>
                  </button>
                );
              })}
            </div>
            <div style={{ ...mono, fontSize: 9, color: 'var(--muted2)', marginTop: 8 }}>follows you across all apps</div>
          </div>

          {/* Accent color */}
          <div>
            <div style={{ ...mono, fontSize: 10, color: 'var(--muted2)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 8 }}>accent color</div>

            <div style={{ ...mono, fontSize: 9, color: 'var(--muted2)', margin: '0 0 6px' }}>Deep</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 12 }}>
              {DEEP_SWATCHES.map(swatch)}
            </div>

            <div style={{ ...mono, fontSize: 9, color: 'var(--muted2)', margin: '0 0 6px' }}>Pastel</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {PASTEL_SWATCHES.map(swatch)}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <span style={{ ...mono, fontSize: 9, color: 'var(--muted2)' }}>preview</span>
              <button style={{ ...mono, fontSize: 11, border: 'none', padding: '6px 14px', borderRadius: 'var(--radius-sm, 6px)', background: 'var(--accent)', color: isLightColor(accent) ? '#1a1a1a' : '#fff' }}>Button</button>
              <button onClick={resetAccent} style={{ ...mono, fontSize: 10, marginLeft: 'auto', padding: '6px 12px', borderRadius: 'var(--radius-sm, 6px)', cursor: 'pointer', border: '1px solid var(--border2)', background: 'transparent', color: 'var(--muted)' }}>reset</button>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
