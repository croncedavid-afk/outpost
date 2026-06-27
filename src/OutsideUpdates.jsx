import React, { useState, useEffect } from 'react';
import { sb } from './supabase.js';

// Status-update log for an OUTSIDE RO. Reads/writes the shared outside_ro_updates
// table — so a note posted here shows in Outpost Units Out, the Outpost RO page,
// and the Shop Command Outside-ROs ETA popup, all at once. Anyone with access can post.
//
// Props: roId (outside_ros.id), roNumber, user, companyId, compact (bool: tighter
// styling for the Shop Command popup), canPost (default true; false hides the post box).
export default function OutsideUpdates({ roId, roNumber, user, companyId, compact, canPost = true }) {
  const [updates, setUpdates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState('');
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState('');

  async function load() {
    if (!roId) { setUpdates([]); setLoading(false); return; }
    setLoading(true);
    try {
      const { data } = await sb.from('outside_ro_updates')
        .select('id,note,created_at,created_by_name')
        .eq('outside_ro_id', roId)
        .order('created_at', { ascending: false })
        .range(0, 199);
      setUpdates(data || []);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [roId]);

  async function post() {
    const text = note.trim();
    if (!text) return;
    setErr(''); setPosting(true);
    try {
      const { error } = await sb.from('outside_ro_updates').insert({
        company_id: companyId || user?.company_id || null,
        outside_ro_id: roId,
        ro_number: roNumber || null,
        note: text,
        created_by: user?.id || null,
        created_by_name: user?.name || user?.email || null,
      });
      if (error) { setErr(error.message); setPosting(false); return; }
      setNote('');
      await load();
    } catch (e) { setErr(String(e?.message || e)); }
    setPosting(false);
  }

  function fmt(ts) {
    const d = new Date(ts);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  const pad = compact ? 0 : 0;

  return (
    <div>
      {!compact && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted2)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 10 }}>
          Status updates
        </div>
      )}

      {/* post box */}
      {canPost && (
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'flex-start' }}>
        <textarea
          className="textarea"
          style={{ flex: 1, fontSize: 13, padding: '9px 11px', minHeight: 40, resize: 'vertical' }}
          rows={compact ? 2 : 2}
          placeholder="Post a status update — e.g. waiting on parts, back Thursday"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) post(); }}
        />
        <button className="btn btn-primary" onClick={post} disabled={posting || !note.trim()}
          style={{ fontSize: 13, padding: '9px 14px', whiteSpace: 'nowrap', alignSelf: 'stretch' }}>
          {posting ? '…' : 'Post'}
        </button>
      </div>
      )}
      {err && <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent)', marginBottom: 10 }}>⚠ {err}</div>}

      {/* log */}
      {loading ? (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)', padding: '6px 0' }}>Loading updates…</div>
      ) : updates.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted2)', padding: '6px 0' }}>No status updates yet. Post the first check-in above.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: compact ? 300 : 'none', overflowY: compact ? 'auto' : 'visible' }}>
          {updates.map((u, i) => (
            <div key={u.id} style={{ padding: '9px 11px', borderLeft: `2px solid ${i === 0 ? 'var(--accent)' : 'var(--border2)'}`, background: i === 0 ? 'var(--red-dim)' : 'var(--surface2, rgba(0,0,0,0.02))', borderRadius: '0 var(--radius-sm) var(--radius-sm) 0' }}>
              <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>{u.note}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted2)', marginTop: 5 }}>
                {u.created_by_name || 'Unknown'} · {fmt(u.created_at)}{i === 0 ? ' · latest' : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
