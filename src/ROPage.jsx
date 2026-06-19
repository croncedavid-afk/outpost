import React, { useState, useEffect, useCallback } from 'react';
import { sb as _sbReal } from './supabase.js';
import { JOB_STATUS } from './shared.js';

// ── READ-ONLY WRITE INTERCEPTOR ──────────────────────────────────────────────
// Outpost renders this page in view-only mode for terminals that have a shop.
// In that mode every WRITE (table insert/update/delete/upsert, and storage
// upload/remove) is hard-blocked at the data layer so nothing can be edited
// regardless of which control is clicked. READS pass straight through
// (getPublicUrl / createSignedUrl / download / select all work), so viewing
// photos, attachments and invoices is unaffected. fullAccess (dispatch-only)
// and tech edits are unaffected because _roReadOnly stays false for them.
let _roReadOnly = false;
export function _setROReadOnly(v) { _roReadOnly = !!v; }
const _blocked = { data: null, error: { message: 'View-only: editing is handled by the shop for this terminal.' } };
function _blockedChain() {
  const p = Promise.resolve(_blocked);
  ['select', 'eq', 'single', 'maybeSingle', 'in', 'not', 'is', 'order', 'limit', 'match', 'neq', 'gte', 'lte', 'like', 'ilike'].forEach((m) => { p[m] = () => p; });
  return p;
}
function _wrapQuery(q) {
  if (!q || typeof q !== 'object') return q;
  ['insert', 'update', 'delete', 'upsert'].forEach((m) => {
    if (typeof q[m] === 'function') q[m] = () => _blockedChain();
  });
  return q;
}
function _wrapStorageBucket(bucket) {
  return new Proxy(bucket, {
    get(t, p) {
      if ((p === 'upload' || p === 'remove') && _roReadOnly) return () => Promise.resolve(_blocked);
      const v = t[p];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}
const sb = new Proxy(_sbReal, {
  get(target, prop) {
    if (prop === 'from') {
      return (...args) => {
        const q = target.from(...args);
        return _roReadOnly ? _wrapQuery(q) : q;
      };
    }
    if (prop === 'storage') {
      return {
        from: (name) => {
          const bucket = target.storage.from(name);
          return _roReadOnly ? _wrapStorageBucket(bucket) : bucket;
        },
      };
    }
    const v = target[prop];
    return typeof v === 'function' ? v.bind(target) : v;
  },
});


// Major casing/recap brands for the REMOVED-tire brand picker. Brand drives
// warranty: a recapped casing's warranty is owned by the recapper, and Bandag IS
// Bridgestone for warranty purposes, so it folds into Bridgestone (recap vs new is
// tracked separately in tire_type). "Other" = off/no-name brands we won't recover on.
// Tire position value -> friendly label (shared by the outside-tire popup + the
// view-only bubble). Mirrors the POS map used in the pickers.
const TIRE_POS_LABEL = (() => {
  const all = [
    ['steer_left','Steer Left'],['steer_right','Steer Right'],
    ['drive_1_left_outer','Drive 1 L Outer'],['drive_1_left_inner','Drive 1 L Inner'],['drive_1_right_inner','Drive 1 R Inner'],['drive_1_right_outer','Drive 1 R Outer'],
    ['drive_2_left_outer','Drive 2 L Outer'],['drive_2_left_inner','Drive 2 L Inner'],['drive_2_right_inner','Drive 2 R Inner'],['drive_2_right_outer','Drive 2 R Outer'],
    ['drive_1_left_ss','Drive 1 L (SS)'],['drive_1_right_ss','Drive 1 R (SS)'],['drive_2_left_ss','Drive 2 L (SS)'],['drive_2_right_ss','Drive 2 R (SS)'],
    ['trailer_1_left_outer','Trlr 1 L Outer'],['trailer_1_left_inner','Trlr 1 L Inner'],['trailer_1_right_inner','Trlr 1 R Inner'],['trailer_1_right_outer','Trlr 1 R Outer'],
    ['trailer_2_left_outer','Trlr 2 L Outer'],['trailer_2_left_inner','Trlr 2 L Inner'],['trailer_2_right_inner','Trlr 2 R Inner'],['trailer_2_right_outer','Trlr 2 R Outer'],
    ['trailer_3_left_outer','Trlr 3 L Outer'],['trailer_3_left_inner','Trlr 3 L Inner'],['trailer_3_right_inner','Trlr 3 R Inner'],['trailer_3_right_outer','Trlr 3 R Outer'],
    ['trailer_1_left_ss','Trlr 1 L (SS)'],['trailer_1_right_ss','Trlr 1 R (SS)'],['trailer_2_left_ss','Trlr 2 L (SS)'],['trailer_2_right_ss','Trlr 2 R (SS)'],['trailer_3_left_ss','Trlr 3 L (SS)'],['trailer_3_right_ss','Trlr 3 R (SS)'],
  ];
  const m = {}; all.forEach(([v, l]) => { m[v] = l; });
  return (v) => m[v] || v;
})();

const MAJOR_TIRE_BRANDS = [
  'Michelin', 'Bridgestone', 'Goodyear', 'Continental', 'Firestone',
  'Yokohama', 'Hankook', 'Toyo', 'Cooper', 'Sailun', 'Double Coin',
  'Pirelli', 'General', 'Kelly', 'Other',
];

// ── TIRE PREMATURE-FAILURE DETECTION ─────────────────────────────────
// On tire install at a position: find the PREVIOUS tire at that same position
// on this unit, evaluate it against its brand/type warranty rule, and if the
// old tire failed prematurely (tread left, in window, not abuse) auto-create a
// warranty claim against the OLD tire's brand. Routing (wty_route_claim) sends
// it to the right vendor; premature claims require photos.
// Parse a DOT WWYY sidewall stamp -> 'YYYY-MM-DD' (approx manufacture date), or
// null for ILLEGIBLE/blank/garbage. Mirrors the SQL dot_to_date(); feeds eval only.
function dotToDateStr(dot) {
  const s = String(dot || '').replace(/\D/g, '');
  if (s.length !== 4) return null;
  const ww = parseInt(s.slice(0, 2), 10);
  const yy = parseInt(s.slice(2), 10);
  if (ww < 1 || ww > 53) return null;
  const year = yy <= 69 ? 2000 + yy : 1900 + yy;
  // Monday of ISO week ww — approximate via Jan 4th anchor (Jan 4 is always in week 1)
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = (jan4.getUTCDay() + 6) % 7; // Mon=0
  const week1Mon = new Date(jan4); week1Mon.setUTCDate(jan4.getUTCDate() - dayOfWeek);
  const target = new Date(week1Mon); target.setUTCDate(week1Mon.getUTCDate() + (ww - 1) * 7);
  return target.toISOString().slice(0, 10);
}

async function detectTireClaim(ro, user, position) {
  const company = user?.company_id;
  if (!company || !ro?.unit_number || !position) return;

  // current mileage (3-tier resolver)
  let curMi = null;
  try {
    const { data: m } = await sb.rpc('unit_current_mileage', { p_company: company, p_unit_number: ro.unit_number });
    if (Array.isArray(m) && m[0]) curMi = m[0].mileage;
  } catch {}

  // find the PREVIOUS tire at this position on this unit (most recent before now,
  // excluding the one just added). Join job_parts -> ro_jobs -> ro_headers by unit.
  const { data: prior } = await sb
    .from('job_parts')
    .select('id, tire_brand, tire_type, tread_depth_32nds, dot_date, install_date, install_mileage, job_id, created_at, ro_jobs!inner(ro_id, ro_headers!inner(unit_number, company_id))')
    .eq('tire_position', position)
    .eq('ro_jobs.ro_headers.unit_number', ro.unit_number)
    .eq('ro_jobs.ro_headers.company_id', company)
    .order('created_at', { ascending: false })
    .range(0, 49);

  // the most recent prior tire that isn't the one we just inserted (skip the newest)
  const list = (prior || []);
  if (list.length < 2) return; // need a previous tire to claim against
  const failed = list[1]; // [0] = just-installed, [1] = the one it replaced

  if (!failed.tire_brand) return;

  // evaluate eligibility
  let ev = null;
  try {
    const { data } = await sb.rpc('tire_claim_eval', {
      p_brand: failed.tire_brand,
      p_tire_type: failed.tire_type || 'new',
      p_tread_32nds: failed.tread_depth_32nds,
      p_install_date: failed.install_date,
      p_cause: '', // cause comes from the job; detection is conservative on abuse here
      p_new_tread_32nds: 18,
      p_mfg_date: dotToDateStr(failed.dot_date),
    });
    if (Array.isArray(data) && data[0]) ev = data[0];
  } catch { return; }
  if (!ev || !ev.eligible) return; // worn out / out of window / abuse -> no claim

  // avoid duplicate claims for the same failed tire
  const { data: dup } = await sb.from('warranty_claims')
    .select('id').eq('company_id', company).eq('unit_number', ro.unit_number)
    .eq('failed_tire_position', position).eq('ro_number', ro.ro_number).limit(1);
  if (dup && dup.length) return;

  // create the claim against the FAILED tire's brand; premature -> photos required
  await sb.from('warranty_claims').insert({
    ro_number: ro.ro_number, ro_id: ro.id, unit_number: ro.unit_number, vin: ro.vin || null,
    location_id: ro.location_id, manufacturer: failed.tire_brand, coverage_group: 'Tires',
    coverage_status: 'in_coverage',
    complaint: 'Premature tire failure at ' + position,
    cause: 'Tire removed with ' + (failed.tread_depth_32nds ?? '?') + '/32 tread remaining',
    correction: 'Replaced tire at ' + position,
    has_complaint: true, has_cause: true, has_correction: true, has_photos: false, has_pm_docs: false,
    claim_status: 'needs_review',
    failed_tire_brand: failed.tire_brand, failed_tire_position: position, failed_dot_date: failed.dot_date || null,
    failed_tire_type: failed.tire_type, failed_tread_32nds: failed.tread_depth_32nds,
    failed_install_mileage: failed.install_mileage, tire_credit_basis: ev.credit_basis,
    company_id: company, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
}

// ── HELPERS ───────────────────────────────────────────────────
function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}
function fmtDateTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
function fmtMins(m) {
  if (!m) return '0m';
  const h = Math.floor(m / 60),
    min = m % 60;
  return h > 0 ? `${h}h ${min}m` : `${min}m`;
}
function fmtCurrency(n) {
  return '$' + (parseFloat(n) || 0).toFixed(2);
}

// ── TIME ENTRIES POPUP ────────────────────────────────────────
function TimeEntriesPopup({ entries, jobTitle, onClose }) {
  const total = entries.reduce((s, e) => s + (e.duration_minutes || 0), 0);
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.45)',
        zIndex: 500,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          background: 'var(--white)',
          borderRadius: 10,
          width: '100%',
          maxWidth: 480,
          boxShadow: '0 8px 32px rgba(0,0,0,.15)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              Time Entries
            </div>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                color: 'var(--muted2)',
                marginTop: 2,
              }}
            >
              {jobTitle} · {fmtMins(total)} total
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--muted2)',
              fontSize: 16,
            }}
          >
            ✕
          </button>
        </div>
        <div
          style={{
            padding: '8px 18px 16px',
            maxHeight: 360,
            overflowY: 'auto',
          }}
        >
          {!entries.length && (
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 12,
                color: 'var(--muted2)',
                padding: '12px 0',
              }}
            >
              No time entries yet
            </div>
          )}
          {entries.map((e) => (
            <div
              key={e.id}
              style={{
                padding: '9px 0',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 6,
                  background: 'var(--page-bg)',
                  border: '1px solid var(--border)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  color: 'var(--muted2)',
                  flexShrink: 0,
                }}
              >
                {(e.user_name || '?').slice(0, 2).toUpperCase()}
              </div>
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 12,
                    fontWeight: 500,
                  }}
                >
                  {e.user_name}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    color: 'var(--muted2)',
                    marginTop: 1,
                  }}
                >
                  {fmtTime(e.clock_in)} →{' '}
                  {e.clock_out ? (
                    fmtTime(e.clock_out)
                  ) : (
                    <span style={{ color: '#16a34a' }}>clocked in</span>
                  )}
                  {e.edited_by && (
                    <span style={{ color: 'var(--amber)', marginLeft: 6 }}>
                      edited
                    </span>
                  )}
                </div>
              </div>
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 12,
                  fontWeight: 500,
                  color: e.clock_out ? 'var(--text)' : '#16a34a',
                }}
              >
                {e.duration_minutes ? (
                  fmtMins(e.duration_minutes)
                ) : (
                  <span style={{ color: '#16a34a' }}>live</span>
                )}
              </div>
            </div>
          ))}
        </div>
        <div
          style={{
            padding: '10px 18px',
            background: 'var(--page-bg)',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--muted2)',
            }}
          >
            {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}
          </span>
          <span
            style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 500 }}
          >
            {fmtMins(total)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── ADD PART POPUP ────────────────────────────────────────────
function AddPartPopup({ jobId, jobComponentCode, unitInfo, ro, user, onClose, onSave }) {
  const [partNum, setPartNum] = useState('');
  const [partName, setPartName] = useState('');
  const [qty, setQty] = useState(1);
  const [cost, setCost] = useState('');
  const [saving, setSaving] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  // FleetStock integration: location stock lots, searchable
  const [stock, setStock] = useState([]);
  const [stockOpen, setStockOpen] = useState(false);
  const [selectedLot, setSelectedLot] = useState(null);
  // Tire capture: when the job/part is a tire, force position + type + tread + brand
  const [tirePosition, setTirePosition] = useState('');
  const [dotDate, setDotDate] = useState('');
  const [tireType, setTireType] = useState('new');
  const [tireBrand, setTireBrand] = useState('');
  const [treadDepth, setTreadDepth] = useState('');
  const [tireSpecs, setTireSpecs] = useState([]);      // available tires from fs_tire_specs
  const [posClass, setPosClass] = useState('any');     // steer|drive|trailer|any from the job
  const [tirePref, setTirePref] = useState(null);      // company preferred tire for this class
  const [selectedTireId, setSelectedTireId] = useState(''); // chosen fs_tire_specs.part_id
  const [removedBrand, setRemovedBrand] = useState('');     // casing brand of the REMOVED tire (drives warranty)
  const [dotIllegible, setDotIllegible] = useState(false);  // sidewall DOT stamp worn/unreadable
  const [brandQuery, setBrandQuery] = useState('');         // 2-letter type-to-filter for the brand dropdown
  const isTireJob = (jobComponentCode || '').startsWith('017');
  const typedTireNoJob = !isTireJob && /tire/i.test(partName);
  const isTire = isTireJob; // tire detail engages only on a real tire job

  // When this is a tire job, load: the job's position_class, the matching tire specs
  // (steer jobs exclude recaps — FMCSA), and the company's preferred tire for the class.
  useEffect(() => {
    if (!isTire || !user?.company_id) return;
    (async () => {
      // 1) position_class from the job's component_code
      let cls = 'any';
      if (jobComponentCode) {
        const { data: jrow } = await sb.from('srt_jobs').select('position_class').eq('component_code', jobComponentCode).limit(1);
        if (jrow && jrow[0] && jrow[0].position_class) cls = jrow[0].position_class;
      }
      setPosClass(cls);
      if (cls === 'steer') setTireType('new'); // FMCSA: no recaps on steer
      // 2) tire specs for this company, filtered by class (+ steer excludes recaps)
      let tq = sb.from('fs_tire_specs').select('part_id,brand,size,tire_type,position_class,steer_eligible').eq('company_id', user.company_id).range(0, 999);
      const { data: specs } = await tq;
      let avail = (specs || []).filter(t => cls === 'any' || t.position_class === cls || t.position_class === 'any');
      if (cls === 'steer') avail = avail.filter(t => t.steer_eligible && t.tire_type !== 'recap'); // hard block
      setTireSpecs(avail);
      // 3) company preference for this class
      if (cls !== 'any') {
        const { data: pref } = await sb.from('tire_preferences').select('preferred_brand,preferred_type,note').eq('company_id', user.company_id).eq('position_class', cls).limit(1);
        if (pref && pref[0]) setTirePref(pref[0]);
      }
    })();
  }, [isTire, jobComponentCode, user?.company_id]);

  // picking a tire from the structured list fills brand/type
  function pickTire(t) {
    setSelectedTireId(t.part_id);
    setTireBrand(t.brand || '');
    setTireType(t.tire_type || 'new');
  }

  useEffect(() => {
    if (!ro?.location_id) return;
    (async () => {
      try {
        let pq = sb.from('fs_parts').select('id,part_number,description,component_code,component_label').eq('location_id', ro.location_id).range(0, 49999);
        if (user?.company_id) pq = pq.eq('company_id', user.company_id);
        let lq = sb.from('fs_stock_lots').select('*').eq('location_id', ro.location_id).range(0, 49999);
        if (user?.company_id) lq = lq.eq('company_id', user.company_id);
        // tire specs for this company so stock rows carry brand/type/class
        let tq = sb.from('fs_tire_specs').select('part_id,brand,size,tire_type,position_class,steer_eligible');
        if (user?.company_id) tq = tq.eq('company_id', user.company_id);
        const [{ data: parts }, { data: lots }, { data: specs }] = await Promise.all([pq, lq, tq]);
        const byId = {};
        (parts || []).forEach((p) => { byId[p.id] = p; });
        const tspecById = {};
        (specs || []).forEach((t) => { tspecById[t.part_id] = t; });
        const rows = (lots || [])
          .filter((l) => byId[l.part_id])
          .map((l) => ({ lot_id: l.id, part_id: l.part_id, unit_cost: Number(l.unit_cost), qty_on_hand: Number(l.qty_on_hand), last_received_at: l.last_received_at, part_number: byId[l.part_id].part_number, description: byId[l.part_id].description, component_code: byId[l.part_id].component_code, tire: tspecById[l.part_id] || null }))
          .sort((a, b) => String(a.last_received_at || '').localeCompare(String(b.last_received_at || '')));
        setStock(rows);
      } catch { /* FleetStock tables not present yet — free-typing still works */ }
    })();
  }, [ro?.location_id]);

  const stockQuery = (stockOpen === 'name' ? partName : partNum).trim().toLowerCase();
  // For tire jobs: restrict matches to tires, honor the job's position_class,
  // and HARD-BLOCK recaps on steer (FMCSA). Preferred tire floats to the top.
  const stockMatches = (() => {
    if (!stockOpen || selectedLot || stockQuery.length < 2) return [];
    // match on part #, description, component/system code, AND tire brand/type/size
    let pool = stock.filter((s) => {
      const hay = [
        s.part_number,
        s.description,
        s.component_code,
        (s.component_code || '').split('-')[0],   // system code, e.g. "017"
        s.tire && s.tire.brand,
        s.tire && s.tire.tire_type,
        s.tire && s.tire.size,
        s.tire && s.tire.position_class,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(stockQuery);
    });
    if (isTire) {
      pool = pool.filter((s) => s.tire); // tires only for a tire job
      if (posClass !== 'any') pool = pool.filter((s) => s.tire.position_class === posClass || s.tire.position_class === 'any');
      if (posClass === 'steer') pool = pool.filter((s) => s.tire.steer_eligible && s.tire.tire_type !== 'recap');
      if (tirePref) pool = [...pool].sort((a, b) => {
        const ap = a.tire.brand === tirePref.preferred_brand && a.tire.tire_type === tirePref.preferred_type ? 0 : 1;
        const bp = b.tire.brand === tirePref.preferred_brand && b.tire.tire_type === tirePref.preferred_type ? 0 : 1;
        return ap - bp;
      });
    }
    return pool.slice(0, 8);
  })();

  function pickStock(s) {
    setPartNum(s.part_number);
    setPartName(s.description || s.part_number);
    setCost(String(s.unit_cost));
    setSelectedLot(s);
    setStockOpen(false);
    // auto-fill tire detail from the selected tire's spec
    if (s.tire) {
      setTireBrand(s.tire.brand || '');
      setTireType(s.tire.tire_type || 'new');
      setSelectedTireId(s.part_id);
    }
  }
  function clearPick() {
    setSelectedLot(null);
    setPartNum('');
    setPartName('');
    setCost('');
  }

  useEffect(() => {
    if (!jobComponentCode) return;
    sb.from('job_parts')
      .select('*')
      .eq('component_code', jobComponentCode)
      .order('usage_count', { ascending: false })
      .limit(5)
      .then(({ data }) => setSuggestions(data || []));
  }, [jobComponentCode]);

  async function save() {
    if (!partName) return;
    // Block adding a tire on a non-tire job — must pick a tire job first (for position + warranty).
    if (typedTireNoJob) {
      alert('This looks like a tire. Add it under a tire job (Replace Steer / Drive / Trailer Tire) so the position and warranty can be tracked. Change this job\'s correction to a tire job first.');
      return;
    }
    // On a tire job, require the data quality needed for warranty: position,
    // removed-tire brand, tread pulled, and a DOT stamp (or an explicit "illegible").
    if (isTire && selectedLot?.tire) {
      if (!tirePosition) { alert('Select the tire position before adding (it drives the warranty claim match).'); return; }
      if (!removedBrand) { alert('Select the brand of the REMOVED tire before adding — it determines who the warranty claim goes to.'); return; }
      if (treadDepth === '' || isNaN(Number(treadDepth))) { alert('Enter the tread pulled (/32) on the removed tire before adding — it drives warranty eligibility.'); return; }
      if (!dotIllegible && !dotDate.trim()) { alert('Enter the DOT date off the removed tire, or mark it Illegible, before adding — it drives the casing-age warranty window.'); return; }
    }
    setSaving(true);
    const totalCost = (parseFloat(cost) || 0) * qty;
    const today = new Date().toISOString().slice(0,10);
    await sb.from('job_parts').insert({
      job_id: jobId,
      part_number: partNum || null,
      part_name: partName,
      quantity: qty,
      unit_cost: parseFloat(cost) || 0,
      total_cost: totalCost,
      component_code: jobComponentCode || null,
      unit_make: unitInfo?.make || null,
      unit_model: unitInfo?.model || null,
      unit_year: unitInfo?.year || null,
      // tire detail (only when adding a tire). tire_brand = the REMOVED tire's
      // casing brand (what warranty is claimed against), NOT the new tire's brand.
      tire_position: isTire ? (tirePosition || null) : null,
      tire_type: isTire ? tireType : null,
      tire_brand: isTire ? (removedBrand || null) : null,
      tread_depth_32nds: isTire && treadDepth !== '' ? Number(treadDepth) : null,
      dot_date: isTire ? (dotIllegible ? 'ILLEGIBLE' : (dotDate.trim() || null)) : null,
      install_date: isTire ? today : null,
    });

    // TIRE PREMATURE-FAILURE DETECTION: when a tire is installed at a position,
    // check the PREVIOUS tire at that position on this unit for a warranty claim.
    if (isTire && tirePosition && ro?.unit_number && user?.company_id) {
      try { await detectTireClaim(ro, user, tirePosition); }
      catch (e) { console.warn('tire claim detection skipped', e); }
    }
    // Update job parts_total
    const { data: allParts } = await sb
      .from('job_parts')
      .select('total_cost')
      .eq('job_id', jobId);
    const newTotal = (allParts || []).reduce(
      (s, p) => s + (p.total_cost || 0),
      0
    );
    await sb.from('ro_jobs').update({ parts_total: newTotal }).eq('id', jobId);
    // FleetStock: pull from location inventory + spend ledger
    if (selectedLot) {
      try {
        const { data: lotRow } = await sb.from('fs_stock_lots').select('qty_on_hand,unit_cost').eq('id', selectedLot.lot_id).single();
        if (lotRow) {
          const newQty = Number(lotRow.qty_on_hand) - qty;
          await sb.from('fs_stock_lots').update({ qty_on_hand: newQty }).eq('id', selectedLot.lot_id);
          const d = new Date();
          const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
          const txn = {
            location_id: ro.location_id, txn_type: 'ro_charge',
            part_id: selectedLot.part_id, part_number: selectedLot.part_number,
            component_code: selectedLot.component_code || jobComponentCode || null,
            qty: -qty, unit_cost: Number(lotRow.unit_cost), total: -(qty * Number(lotRow.unit_cost)),
            ro_number: ro.ro_number || null, unit_number: ro.unit_number || null,
            ref_table: 'job_parts', note: ('RO ' + (ro.ro_number || '')).trim(),
            user_id: user?.id || null, user_name: user?.name || null, txn_date: today,
          };
          if (user?.company_id) txn.company_id = user.company_id;
          await sb.from('fs_transactions').insert(txn);
          if (newQty < 0) alert('Heads up: ' + selectedLot.part_number + ' stock is now ' + newQty + ' at this location (negative).');
        }
      } catch (e) { console.warn('FleetStock charge failed', e); }
    }
    setSaving(false);
    onSave();
    onClose();
  }

  function useSuggestion(s) {
    setPartNum(s.part_number || '');
    setPartName(s.part_name || '');
    setCost(s.unit_cost?.toString() || '');
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.45)',
        zIndex: 500,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          background: 'var(--white)',
          borderRadius: 10,
          width: '100%',
          maxWidth: 500,
          boxShadow: '0 8px 32px rgba(0,0,0,.15)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div
            style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 500 }}
          >
            Add Part to Job
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--muted2)',
              fontSize: 16,
            }}
          >
            ✕
          </button>
        </div>
        <div
          style={{
            padding: 18,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {suggestions.length > 0 && (
            <div>
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  color: 'var(--muted2)',
                  textTransform: 'uppercase',
                  letterSpacing: '.06em',
                  marginBottom: 7,
                }}
              >
                Suggested parts — {jobComponentCode}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {suggestions.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => useSuggestion(s)}
                    style={{
                      padding: '7px 10px',
                      background: 'var(--page-bg)',
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          fontFamily: 'var(--mono)',
                          fontSize: 11,
                          fontWeight: 500,
                        }}
                      >
                        {s.part_name}
                      </div>
                      <div
                        style={{
                          fontFamily: 'var(--mono)',
                          fontSize: 10,
                          color: 'var(--muted2)',
                        }}
                      >
                        {s.part_number} · used {s.usage_count || 0}x
                      </div>
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                      {fmtCurrency(s.unit_cost)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}
          >
            <div className="form-group">
              <div className="form-label">Part Number</div>
              <div style={{ display: 'flex', gap: 6, position: 'relative' }}>
                <input
                  className="input"
                  value={partNum}
                  readOnly={!!selectedLot}
                  onChange={(e) => { if (selectedLot) return; setPartNum(e.target.value); setStockOpen('num'); }}
                  onFocus={() => { if (!selectedLot) setStockOpen('num'); }}
                  onBlur={() => setTimeout(() => setStockOpen(false), 180)}
                  placeholder="search part #, code (e.g. 017), or brand"
                  style={{ flex: 1, paddingRight: selectedLot ? 26 : undefined, opacity: selectedLot ? 0.85 : 1 }}
                />
                {selectedLot && (
                  <span onMouseDown={(e) => { e.preventDefault(); clearPick(); }} title="Clear selected part"
                    style={{ position: 'absolute', right: 44, top: '50%', transform: 'translateY(-50%)', cursor: 'pointer', color: 'var(--muted)', fontSize: 14, lineHeight: 1, padding: 4, zIndex: 5 }}>✕</span>
                )}
                {stockOpen === 'num' && stockMatches.length > 0 && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 600, background: 'var(--white)', border: '1px solid var(--border2)', borderRadius: 6, boxShadow: 'var(--shadow-md)', width: 'min(420px, 80vw)', maxHeight: 240, overflowY: 'auto' }}>
                    {stockMatches.map((s) => (
                      <div key={s.lot_id} onMouseDown={() => pickStock(s)} style={{ padding: '7px 10px', fontSize: 12, cursor: 'pointer', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{s.part_number}</span>
                        {s.tire && (
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, padding: '1px 5px', borderRadius: 4, background: s.tire.tire_type === 'recap' ? 'var(--blue-dim)' : 'var(--green-dim)', color: s.tire.tire_type === 'recap' ? 'var(--blue)' : 'var(--green)', flexShrink: 0 }}>{s.tire.brand} · {s.tire.tire_type}</span>
                        )}
                        <span style={{ color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.description}</span>
                        {s.component_code && <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted2)', flexShrink: 0 }}>{s.component_code}</span>}
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: s.qty_on_hand <= 0 ? 'var(--accent)' : 'var(--muted2)', flexShrink: 0 }}>{s.qty_on_hand} @ ${s.unit_cost.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                )}
                <button
                  className="btn btn-sm"
                  title="Scan barcode (coming soon)"
                  style={{ flexShrink: 0, opacity: 0.5, cursor: 'not-allowed' }}
                >
                  ▤
                </button>
              </div>
            </div>
            <div className="form-group">
              <div className="form-label">Part Name *</div>
              <div style={{ position: 'relative' }}>
                <input
                  className="input"
                  value={partName}
                  readOnly={!!selectedLot}
                  onChange={(e) => { if (selectedLot) return; setPartName(e.target.value); setStockOpen('name'); }}
                  onFocus={() => { if (!selectedLot) setStockOpen('name'); }}
                  onBlur={() => setTimeout(() => setStockOpen(false), 180)}
                  placeholder="search name, code, or tire brand"
                  style={{ width: '100%', paddingRight: selectedLot ? 26 : undefined, opacity: selectedLot ? 0.85 : 1 }}
                />
                {selectedLot && (
                  <span onMouseDown={(e) => { e.preventDefault(); clearPick(); }} title="Clear selected part"
                    style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', cursor: 'pointer', color: 'var(--muted)', fontSize: 14, lineHeight: 1, padding: 4, zIndex: 5 }}>✕</span>
                )}
                {stockOpen === 'name' && stockMatches.length > 0 && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 600, background: 'var(--white)', border: '1px solid var(--border2)', borderRadius: 6, boxShadow: 'var(--shadow-md)', width: 'min(420px, 80vw)', maxHeight: 240, overflowY: 'auto' }}>
                    {stockMatches.map((s) => (
                      <div key={s.lot_id} onMouseDown={() => pickStock(s)} style={{ padding: '7px 10px', fontSize: 12, cursor: 'pointer', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{s.part_number}</span>
                        {s.tire && (
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, padding: '1px 5px', borderRadius: 4, background: s.tire.tire_type === 'recap' ? 'var(--blue-dim)' : 'var(--green-dim)', color: s.tire.tire_type === 'recap' ? 'var(--blue)' : 'var(--green)', flexShrink: 0 }}>{s.tire.brand} · {s.tire.tire_type}</span>
                        )}
                        <span style={{ color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.description}</span>
                        {s.component_code && <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted2)', flexShrink: 0 }}>{s.component_code}</span>}
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: s.qty_on_hand <= 0 ? 'var(--accent)' : 'var(--muted2)', flexShrink: 0 }}>{s.qty_on_hand} @ ${s.unit_cost.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {typedTireNoJob && (
              <div style={{ padding: '8px 12px', borderRadius: 6, background: 'var(--red-dim, rgba(142,0,0,0.07))', border: '1px solid var(--accent)', color: 'var(--accent)', fontFamily: 'var(--sans)', fontSize: 12 }}>
                ⚠ This looks like a tire. To track position and warranty, add it under a <b>tire job</b> — set this job's correction to <b>Replace Steer / Drive / Trailer Tire</b> first, then add the tire.
              </div>
            )}
            <div className="form-group">
              <div className="form-label">Quantity</div>
              <input
                className="input"
                type="number"
                min="1"
                value={qty}
                onChange={(e) => setQty(parseInt(e.target.value) || 1)}
              />
            </div>
            <div className="form-group">
              <div className="form-label">Unit Cost ($)</div>
              <input
                className="input"
                type="number"
                step="0.01"
                value={cost}
                readOnly={!!selectedLot}
                onChange={(e) => { if (!selectedLot) setCost(e.target.value); }}
                placeholder="0.00"
                title={selectedLot ? 'Price comes from FleetStock — clear the part to enter a custom price' : undefined}
                style={{ opacity: selectedLot ? 0.85 : 1, cursor: selectedLot ? 'not-allowed' : undefined }}
              />
            </div>
          </div>
          {selectedLot && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, padding: '6px 10px', borderRadius: 5, background: 'var(--green-dim, rgba(21,128,61,0.08))', color: 'var(--green, #15803d)', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              ✓ from FleetStock — {selectedLot.qty_on_hand} on hand @ ${selectedLot.unit_cost.toFixed(2)} · will deduct {qty} from this location's inventory
              <span style={{ cursor: 'pointer', marginLeft: 'auto' }} onClick={clearPick} title="Clear selected part">✕</span>
            </div>
          )}
          {/* Tire detail appears ONLY after a tire is selected from inventory.
              Brand/type come from the picked tire; tech adds position + tread-pulled. */}
          {isTire && selectedLot?.tire && (
            <div style={{ padding: 12, borderRadius: 8, background: 'var(--amber-dim)', border: '1px solid var(--border2)', display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 8 }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--amber)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                🛞 Tire detail — {selectedLot.tire.brand} · {selectedLot.tire.tire_type}{selectedLot.tire.size ? ' · ' + selectedLot.tire.size : ''}
              </div>
              {(() => {
                const POS = {
                  steer: [['steer_left','Steer Left'],['steer_right','Steer Right']],
                  drive: [['drive_1_left_outer','Drive 1 L Outer'],['drive_1_left_inner','Drive 1 L Inner'],['drive_1_right_inner','Drive 1 R Inner'],['drive_1_right_outer','Drive 1 R Outer'],['drive_2_left_outer','Drive 2 L Outer'],['drive_2_left_inner','Drive 2 L Inner'],['drive_2_right_inner','Drive 2 R Inner'],['drive_2_right_outer','Drive 2 R Outer'],['drive_1_left_ss','Drive 1 L (SS)'],['drive_1_right_ss','Drive 1 R (SS)'],['drive_2_left_ss','Drive 2 L (SS)'],['drive_2_right_ss','Drive 2 R (SS)']],
                  trailer: [['trailer_1_left_outer','Trlr 1 L Outer'],['trailer_1_left_inner','Trlr 1 L Inner'],['trailer_1_right_inner','Trlr 1 R Inner'],['trailer_1_right_outer','Trlr 1 R Outer'],['trailer_2_left_outer','Trlr 2 L Outer'],['trailer_2_left_inner','Trlr 2 L Inner'],['trailer_2_right_inner','Trlr 2 R Inner'],['trailer_2_right_outer','Trlr 2 R Outer'],['trailer_3_left_outer','Trlr 3 L Outer'],['trailer_3_left_inner','Trlr 3 L Inner'],['trailer_3_right_inner','Trlr 3 R Inner'],['trailer_3_right_outer','Trlr 3 R Outer'],['trailer_1_left_ss','Trlr 1 L (SS)'],['trailer_1_right_ss','Trlr 1 R (SS)'],['trailer_2_left_ss','Trlr 2 L (SS)'],['trailer_2_right_ss','Trlr 2 R (SS)'],['trailer_3_left_ss','Trlr 3 L (SS)'],['trailer_3_right_ss','Trlr 3 R (SS)']],
                };
                const opts = posClass === 'any' ? [...POS.steer, ...POS.drive, ...POS.trailer] : (POS[posClass] || []);
                return (
                  <>
                  <div className="form-group">
                    <div className="form-label">Position * {posClass !== 'any' && <span style={{ color:'var(--muted2)', fontWeight:400 }}>({posClass} positions only)</span>}</div>
                    <select className="input" value={tirePosition} onChange={(e) => setTirePosition(e.target.value)}>
                      <option value="">— select position —</option>
                      {opts.map(([v,l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <div className="form-label">Brand removed * <span style={{ color:'var(--muted2)', fontWeight:400 }}>(casing brand of the OLD tire — drives the claim)</span></div>
                    <input
                      className="input"
                      list="removed-brand-list"
                      value={removedBrand}
                      onChange={(e) => setRemovedBrand(e.target.value)}
                      placeholder="type 2 letters to filter, or pick…"
                      autoComplete="off"
                    />
                    <datalist id="removed-brand-list">
                      {MAJOR_TIRE_BRANDS.map(b => <option key={b} value={b} />)}
                    </datalist>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div className="form-group">
                      <div className="form-label">Tread pulled (/32) *</div>
                      <input className="input" type="number" value={treadDepth} onChange={(e) => setTreadDepth(e.target.value)} placeholder="depth of OLD tire" />
                    </div>
                    <div className="form-group">
                      <div className="form-label">DOT date (mfr) *</div>
                      <input className="input" value={dotIllegible ? '' : dotDate} disabled={dotIllegible} onChange={(e) => setDotDate(e.target.value)} placeholder={dotIllegible ? 'marked illegible' : 'e.g. 2419 (wk/yr) off old tire'} style={dotIllegible ? { opacity: 0.5 } : {}} />
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, fontSize: 11, color: 'var(--muted)', cursor: 'pointer' }}>
                        <input type="checkbox" checked={dotIllegible} onChange={(e) => { setDotIllegible(e.target.checked); if (e.target.checked) setDotDate(''); }} />
                        DOT stamp illegible / worn off
                      </label>
                    </div>
                  </div>
                  </>
                );
              })()}
              <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--sans)' }}>
                Record the <b>removed</b> tire's tread depth and DOT date (week/year stamped on the sidewall) — both drive warranty eligibility. If it failed early with tread left and within the casing-age window, a claim is auto-checked against its brand.
              </div>
            </div>
          )}
          {cost && qty && (
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 12,
                color: 'var(--muted2)',
                textAlign: 'right',
              }}
            >
              Total:{' '}
              <strong style={{ color: 'var(--text)' }}>
                {fmtCurrency(parseFloat(cost) * qty)}
              </strong>
            </div>
          )}
        </div>
        <div
          style={{
            padding: '12px 18px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
          }}
        >
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={saving || !partName}
          >
            {saving ? 'Adding…' : 'Add Part'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── JOB CARD ──────────────────────────────────────────────────
function JobCard({ job, ro, user, isTech, onSave, isOutside }) {
  const [editing, setEditing] = useState(false);
  const [complaint, setComplaint] = useState(job.complaint || '');
  const [cause, setCause] = useState(job.cause || '');
  const [srtJobId, setSrtJobId] = useState(job.srt_job_id || null);
  const [srtQuery, setSrtQuery] = useState('');
  const [srtResults, setSrtResults] = useState([]);
  const [srtGoal, setSrtGoal] = useState(null);
  const [unitClass, setUnitClass] = useState('truck');
  const [correction, setCorrection] = useState(job.correction || '');
  const [status, setStatus] = useState(job.status || 'not_started');
  const [parts, setParts] = useState([]);
  const [timeEntries, setTimeEntries] = useState([]);
  const [photos, setPhotos] = useState([]);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showTimePopup, setShowTimePopup] = useState(false);
  const [showAddPart, setShowAddPart] = useState(false);
  const [tirePopup, setTirePopup] = useState(null); // outside RO: {posClass, jobCode} when a replace-tire correction is picked
  const [tireDraft, setTireDraft] = useState(null); // outside RO: {positions:[], brand:''} held locally until Save Job; null = show committed
  const [compCodes, setCompCodes] = useState([]);
  const [compCode, setCompCode] = useState(job.component_code || '');
  const [dialog, setDialog] = useState(null); // {type:'notice'|'confirm', text, onOk}
  const [laborRate, setLaborRate] = useState(125);
  const [mgrLimit, setMgrLimit] = useState(null);
  const [reqApproval, setReqApproval] = useState(false);
  const [estInput, setEstInput] = useState('');
  const [estNotes, setEstNotes] = useState('');
  const [histWarn, setHistWarn] = useState(null);
  const [srtSystems, setSrtSystems] = useState([]);      // taxonomy: {system_code, group_code, group_name, name}
  const [showBrowse, setShowBrowse] = useState(false);   // tree expanded?
  const [openGroup, setOpenGroup] = useState(null);      // expanded group_code
  const [openSystem, setOpenSystem] = useState(null);    // expanded system_code
  const [openAssembly, setOpenAssembly] = useState(null);// expanded component_code (assembly w/ >10 jobs)

  const jobStatus = JOB_STATUS[job.status] || JOB_STATUS.not_started;
  const jobCost = (job.parts_total || 0) + (job.total_hours || 0) * laborRate;

  useEffect(() => {
    (async () => {
      const { data: loc } = await sb.from('locations').select('labor_rate').eq('id', ro.location_id).single();
      if (ro.unit_id) {
        const { data: u } = await sb.from('units').select('unit_subtype').eq('id', ro.unit_id).single();
        if (u) setUnitClass(['trailer', 'tanker_trailer'].includes(u.unit_subtype) ? 'trailer' : 'truck');
      }
      if (loc?.labor_rate) setLaborRate(Number(loc.labor_rate));
      const { data: mgrs } = await sb.from('users').select('approval_limit').eq('location_id', ro.location_id).eq('role', 'manager').not('approval_limit', 'is', null);
      const limits = (mgrs || []).map((m) => Number(m.approval_limit)).filter((n) => n > 0);
      if (limits.length) setMgrLimit(Math.min(...limits));
    })();
  }, [ro.location_id]);

  // AUTO GATE: cost crossed the location manager's limit -> waiting
  useEffect(() => {
    if (job.status !== 'inprogress' || job.approved || mgrLimit == null) return;
    if (jobCost > mgrLimit) {
      sb.from('ro_jobs').update({
        status: 'waiting', auto_flagged: true,
        estimate_total: Math.round(jobCost),
        approval_requested_at: new Date().toISOString(),
        approval_requested_by_name: 'auto (cost over limit)',
      }).eq('id', job.id).then(() => { load(); onSave(); });
    }
  }, [jobCost, mgrLimit, job.status, job.approved]);

  // PREDICTIVE WARNING: history for this component code vs the SM limit
  useEffect(() => {
    (async () => {
      setHistWarn(null);
      if (!editing || isTech || !compCode || mgrLimit == null) return;
      const { data: hist } = await sb.from('ro_jobs').select('parts_total,total_hours')
        .eq('component_code', compCode).in('status', ['finished']).limit(200);
      const finals = (hist || []).map((h) => (h.parts_total || 0) + (h.total_hours || 0) * laborRate).filter((n) => n > 0);
      if (finals.length >= 3) {
        const avg = finals.reduce((s, n) => s + n, 0) / finals.length;
        if (avg > mgrLimit) setHistWarn({ avg: Math.round(avg), n: finals.length });
      }
    })();
  }, [compCode, editing, mgrLimit, laborRate]);

  async function requestApproval() {
    const est = parseFloat(estInput);
    if (!est || est <= 0) { setDialog({ type: 'notice', title: 'Estimate required', text: 'Enter an estimated total for this job.' }); return; }
    await sb.from('ro_jobs').update({
      status: 'waiting', auto_flagged: false,
      estimate_total: est, approval_notes: estNotes || null,
      approval_requested_by: user.id, approval_requested_by_name: user.name || user.email,
      approval_requested_at: new Date().toISOString(),
    }).eq('id', job.id);
    setReqApproval(false); setEstInput(''); setEstNotes('');
    load(); onSave();
  }
  const totalTime = timeEntries.reduce(
    (s, e) => s + (e.duration_minutes || 0),
    0
  );
  const isLive = timeEntries.some((e) => !e.clock_out);
  const partsTotal = parts.reduce((s, p) => s + (p.total_cost || 0), 0);

  const load = useCallback(async () => {
    const [pr, tr, cr, phr] = await Promise.all([
      sb.from('job_parts').select('*').eq('job_id', job.id).order('created_at'),
      sb
        .from('job_time_entries')
        .select('*')
        .eq('job_id', job.id)
        .order('clock_in'),
      sb.from('srt_systems').select('system_code,name,group_code').order('system_code').range(0, 9999),
      sb.from('job_photos').select('*').eq('job_id', job.id).eq('hidden', false).order('uploaded_at'),
    ]);
    setParts(pr.data || []);
    setTimeEntries(tr.data || []);
    setCompCodes((cr.data || []).map((c) => ({ code: c.system_code, description: c.name, system: c.system_code, goal_time: null })));
    setPhotos(phr.data || []);
  }, [job.id]);

  useEffect(() => {
    load();
  }, [load]);

  // trimmed mean: drop top/bottom 15%, average middle 70%; fallback to base
  function trimmedEstimate(times, base) {
    if (!times || times.length < 10) return base ?? null;
    const sorted = [...times].sort((a, b) => a - b);
    const cut = Math.floor(sorted.length * 0.15);
    const mid = sorted.slice(cut, sorted.length - cut);
    return Math.round((mid.reduce((s, n) => s + n, 0) / mid.length) * 100) / 100;
  }

  // Load the full active catalog once when the edit form opens (all classes —
  // 000 utility jobs apply everywhere; trailer-specific jobs come later as data)
  useEffect(() => {
    if (!editing) return;
    (async () => {
      const { data } = await sb.from('srt_jobs').select('id,label,system_code,component_code,base_srt_hours')
        .eq('active', true).order('label').range(0, 9999);
      setSrtResults(data || []);
      const { data: sys } = await sb.from('srt_systems')
        .select('system_code,group_code,group_name,name').order('group_code').range(0, 999);
      setSrtSystems(sys || []);
    })();
  }, [editing]);

  async function applySrtPick(sj) {
    setSrtJobId(sj.id);
    setCompCode(sj.component_code || sj.system_code || '');
    const { data: times } = await sb.from('srt_job_times').select('actual_hours').eq('srt_job_id', sj.id).range(0, 4999);
    const est = trimmedEstimate((times || []).map(t => Number(t.actual_hours)), sj.base_srt_hours ? Number(sj.base_srt_hours) : null);
    setSrtGoal(est);
    // Outside RO only: a replace-tire correction (017-001..004) opens the tire popup
    // (which positions + brand installed). No parts on outside ROs, so this is the
    // only tire-capture path. Cancel/close clears the correction so they can search again.
    if (isOutside) {
      const cc = sj.component_code || '';
      const TIRE_CLASS = { '017-001': 'any', '017-002': 'steer', '017-003': 'drive', '017-004': 'trailer' };
      if (TIRE_CLASS[cc]) {
        // Re-picking a tire correction wipes any prior selection for THIS job and reopens fresh.
        setTireDraft({ positions: [], brand: '' });
        setTirePopup({ posClass: TIRE_CLASS[cc], jobCode: cc });
      }
    }
  }

  // Clear the just-picked tire correction so the user can search the catalog again.
  function clearTireCorrection() {
    setTirePopup(null);
    setTireDraft(null);
    setCorrection('');
    setSrtJobId(null);
    setCompCode('');
    setSrtGoal(null);
  }

  // Popup confirm: hold the selection in a local DRAFT only. Nothing is written
  // to the database until the user clicks Save Job, so a refresh without saving
  // discards it. The bubble reads the draft while it exists.
  function saveOutsideTires(positions, brand) {
    if (!positions.length) { clearTireCorrection(); return; }
    setTireDraft({ positions, brand: brand || '' });
    setTirePopup(null);
  }

  function onCorrectionInput(v) {
    setCorrection(v);
    const hit = srtResults.find((sj) => sj.label.toLowerCase() === v.toLowerCase());
    if (hit) { applySrtPick(hit); }
    else { setSrtJobId(null); setSrtGoal(null); }
  }

  // ── Failure photos: upload to inspection-photos, map to this job ──
  const PHOTO_BUCKET = 'inspection-photos';
  function photoUrl(path) {
    return sb.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;
  }
  // Compress/resize before upload: longest edge -> 1600px max, JPEG q0.72.
  // Keeps the failure clearly legible while cutting size + upload time a lot.
  // Falls back to the original file if anything goes wrong (HEIC, etc.).
  async function compressImage(file) {
    try {
      if (!file.type || !file.type.startsWith('image/')) return file;
      const MAX = 1600, Q = 0.72;
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(file);
      });
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = dataUrl;
      });
      let { width: w, height: h } = img;
      if (Math.max(w, h) > MAX) {
        const s = MAX / Math.max(w, h);
        w = Math.round(w * s); h = Math.round(h * s);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', Q));
      if (!blob) return file;
      // If compression didn't actually help (e.g. tiny image), keep smaller one.
      if (blob.size >= file.size && file.type === 'image/jpeg') return file;
      return new File([blob], 'photo.jpg', { type: 'image/jpeg' });
    } catch {
      return file;
    }
  }
  async function uploadPhoto(rawFile) {
    if (!rawFile) return;
    setUploadingPhoto(true);
    try {
      const company = ro.company_id || user?.company_id;
      if (!company) { alert('Cannot link photo: no company on this RO or user. Please re-open the RO from the dashboard.'); return; }
      const file = await compressImage(rawFile);
      const isJpeg = file.type === 'image/jpeg';
      const ext = isJpeg ? 'jpg' : ((rawFile.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg');
      const rand = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));
      const path = `${company}/ro/${ro.id}/job/${job.id}/${rand}.${ext}`;
      const { error: upErr } = await sb.storage.from(PHOTO_BUCKET).upload(path, file, { upsert: false, contentType: file.type || 'image/jpeg' });
      if (upErr) { alert('Photo upload failed: ' + upErr.message); return; }
      const { error: rowErr } = await sb.from('job_photos').insert({
        job_id: job.id, ro_id: ro.id, company_id: company, storage_path: path, uploaded_by: user?.id || null,
      });
      if (rowErr) { alert('Photo saved to storage but linking failed: ' + rowErr.message); return; }
      await load();
    } finally {
      setUploadingPhoto(false);
    }
  }
  // soft delete: hide from the job (file is retained, recoverable)
  async function hidePhoto(photoId) {
    await sb.from('job_photos').update({ hidden: true, hidden_by: user?.id || null, hidden_at: new Date().toISOString() }).eq('id', photoId);
    await load();
  }

  // Delete a job — only when it has NO time entries and NO parts. Re-checks
  // the live child tables right before deleting so a stale UI can't delete a
  // job that just got time/parts added. Any role may delete an empty job
  // (no time = nobody clocked in = nothing to protect).
  const jobIsEmpty = timeEntries.length === 0 && parts.length === 0;
  async function deleteJob() {
    const [{ count: tCount }, { count: pCount }] = await Promise.all([
      sb.from('job_time_entries').select('*', { count: 'exact', head: true }).eq('job_id', job.id),
      sb.from('job_parts').select('*', { count: 'exact', head: true }).eq('job_id', job.id),
    ]);
    if ((tCount || 0) > 0 || (pCount || 0) > 0) {
      alert('This job now has time or parts and can no longer be deleted.');
      onSave();
      return;
    }
    if (!confirm('Delete job J' + job.job_number + '? This cannot be undone.')) return;
    try {
      // Clean up any photos tied to this job (storage + rows), then the job.
      const { data: phs } = await sb.from('job_photos').select('id,storage_path').eq('job_id', job.id);
      const paths = (phs || []).map((p) => p.storage_path).filter(Boolean);
      if (paths.length) { try { await sb.storage.from('inspection-photos').remove(paths); } catch {} }
      await sb.from('job_photos').delete().eq('job_id', job.id);
      const { error } = await sb.from('ro_jobs').delete().eq('id', job.id);
      if (error) throw error;
      onSave();
    } catch (e) { alert('Delete failed: ' + (e?.message || e)); }
  }

  async function saveJob() {
    setSaving(true);
    try {
      const finalCorrection = correction || null;
      const { error } = await sb
        .from('ro_jobs')
        .update({
          complaint: complaint || job.complaint,
          cause: cause || null,
          correction: finalCorrection,
          component_code: compCode || null,
          srt_job_id: srtJobId,
          goal_time: srtGoal ?? compCodes.find((c) => c.code === compCode)?.goal_time ?? job.goal_time,
          status,
        })
        .eq('id', job.id);
      if (error) throw error;
      // Outside RO tire sync — commit happens here, not in the popup.
      if (isOutside) {
        const TIRE_CODES = ['017-001', '017-002', '017-003', '017-004'];
        const isTireJob = TIRE_CODES.includes(compCode);
        if (!isTireJob) {
          // correction is no longer a tire job: remove any tire rows for THIS job
          await sb.from('job_parts').delete().eq('job_id', job.id).not('tire_position', 'is', null);
        } else if (tireDraft) {
          // user made a tire selection this session: replace this job's tire rows with it
          await sb.from('job_parts').delete().eq('job_id', job.id).not('tire_position', 'is', null);
          if (tireDraft.positions.length) {
            const rows = tireDraft.positions.map((pos) => ({
              job_id: job.id, part_name: 'Tire (outside install)', quantity: 1,
              component_code: compCode || '017-001', tire_position: pos,
              tire_brand: tireDraft.brand || null, created_by: user?.id || null,
            }));
            const { error: tErr } = await sb.from('job_parts').insert(rows);
            if (tErr) throw tErr;
          }
        }
        // else: tire job but no new selection this session -> leave committed rows as-is
      }
      setTireDraft(null);
      setEditing(false);
      await load();
      onSave();
    } catch (err) {
      console.error('Save failed:', err.message || err);
      alert('Save failed: ' + (err.message || 'Unknown error'));
    } finally {
      setSaving(false);
    }
  }

  function finishJob() {
    const corr = correction || job.correction;
    if (
      !(complaint || job.complaint) ||
      !(cause || job.cause) ||
      !corr ||
      !(compCode || job.component_code)
    ) {
      setDialog({
        type: 'notice',
        title: 'Job incomplete',
        text: 'Complete the complaint, cause, correction, and component before finishing this job.',
      });
      return;
    }
    setDialog({
      type: 'confirm',
      title: `Finish J${job.job_number}?`,
      text: 'Once every job on this RO is finished it moves to SM review.',
      onOk: doFinish,
    });
  }

  async function doFinish() {
    setDialog(null);
    // Close any open time entries on this job
    const { data: openEnts } = await sb
      .from('job_time_entries')
      .select('*')
      .eq('job_id', job.id)
      .is('clock_out', null);
    for (const e of openEnts || []) {
      const now = new Date();
      await sb
        .from('job_time_entries')
        .update({
          clock_out: now.toISOString(),
          duration_minutes: Math.round((now - new Date(e.clock_in)) / 60000),
        })
        .eq('id', e.id);
    }
    await sb.from('ro_jobs').update({ status: 'finished' }).eq('id', job.id);
    // Inside ROs auto-move to SM review once every job is finished. Outside ROs do NOT
    // auto-finish here — they require the validated "Mark Finished" (vendor/invoice checks).
    if (!isOutside) {
      const { data: sibs } = await sb
        .from('ro_jobs')
        .select('status')
        .eq('ro_id', ro.id);
      if ((sibs || []).every((j) => ['finished', 'denied'].includes(j.status))) {
        await sb
          .from('ro_headers')
          .update({ status: 'finished', finished_date: new Date().toISOString() })
          .eq('id', ro.id);
      }
    }
    load();
    onSave();
  }

  async function clockIn() {
    if (job.status === 'waiting') {
      setDialog({ type: 'notice', title: 'Awaiting approval', text: 'This job is waiting for approval and cannot be worked until it is approved.' });
      return;
    }
    // One job at a time: close any open entry for this tech before opening a new one
    const { data: openEntries } = await sb
      .from('job_time_entries')
      .select('*')
      .eq('user_id', user.id)
      .is('clock_out', null)
      .neq('entry_type', 'end_of_day');
    const closeNow = new Date();
    for (const e of openEntries || []) {
      const dur = Math.round((closeNow - new Date(e.clock_in)) / 60000);
      await sb.from('job_time_entries').update({ clock_out: closeNow.toISOString(), duration_minutes: dur }).eq('id', e.id);
      if (e.entry_type === 'job' && e.job_id) {
        const { data: prevAll } = await sb.from('job_time_entries').select('duration_minutes').eq('job_id', e.job_id);
        const prevMins = (prevAll || []).reduce((s, x) => s + (x.duration_minutes || 0), 0);
        await sb.from('ro_jobs').update({ total_hours: parseFloat((prevMins / 60).toFixed(2)) }).eq('id', e.job_id);
      }
    }
    await sb.from('job_time_entries').insert({
      job_id: job.id,
      user_id: user.id,
      user_name: user.name || user.email,
      clock_in: new Date().toISOString(),
      entry_type: 'job',
    });
    await sb.from('ro_jobs').update({ status: 'inprogress' }).eq('id', job.id);
    load();
    onSave();
  }

  async function clockOut() {
    const { data: open } = await sb
      .from('job_time_entries')
      .select('*')
      .eq('job_id', job.id)
      .eq('user_id', user.id)
      .is('clock_out', null)
      .limit(1);
    if (!open?.length) return;
    const now = new Date();
    const dur = Math.round((now - new Date(open[0].clock_in)) / 60000);
    await sb
      .from('job_time_entries')
      .update({ clock_out: now.toISOString(), duration_minutes: dur })
      .eq('id', open[0].id);
    // Recalculate total hours for this job from all time entries
    const { data: allEntries } = await sb
      .from('job_time_entries')
      .select('duration_minutes')
      .eq('job_id', job.id);
    const totalMins = (allEntries || []).reduce(
      (s, e) => s + (e.duration_minutes || 0),
      0
    );
    const totalHours = parseFloat((totalMins / 60).toFixed(2));
    await sb
      .from('ro_jobs')
      .update({ total_hours: totalHours })
      .eq('id', job.id);
    // Recalculate ro_headers total_hours from all jobs
    const { data: allJobs } = await sb
      .from('ro_jobs')
      .select('total_hours')
      .eq('ro_id', ro.id);
    const roTotalHours = (allJobs || []).reduce(
      (s, j) => s + (j.total_hours || 0),
      0
    );
    await sb
      .from('ro_headers')
      .update({ total_hours: roTotalHours })
      .eq('id', ro.id);
    // Note: job status stays inprogress after clock out
    // Tech/SM must explicitly mark job as finished
    load();
    onSave();
  }

  async function deletePart(partId) {
    await sb.from('job_parts').delete().eq('id', partId);
    // Recalculate and update ro total_parts
    const { data: allParts } = await sb
      .from('job_parts')
      .select('total_cost')
      .eq('job_id', job.id);
    const newTotal = (allParts || []).reduce(
      (s, p) => s + (p.total_cost || 0),
      0
    );
    await sb.from('ro_jobs').update({ parts_total: newTotal }).eq('id', job.id);
    load();
    onSave();
  }

  const isPM = job.component_code?.startsWith('PMI-');
  const overGoal = totalTime > 0 && totalTime / 60 > job.goal_time * 1.1;

  return (
    <div
      style={{
        background: 'var(--white)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${jobStatus.color}`,
        borderRadius: 8,
        overflow: 'hidden',
        marginBottom: 10,
      }}
    >
      {/* Job header */}
      <div
        style={{
          padding: '11px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            background: 'var(--page-bg)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '2px 7px',
            color: 'var(--muted2)',
            flexShrink: 0,
          }}
        >
          {(job.component_code || '').split('-')[0] || 'J' + job.job_number}
        </span>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 13,
            fontWeight: 500,
            flex: 1,
          }}
        >
          {job.complaint}
        </span>
        {isPM && (
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              background: 'rgba(29,78,216,.08)',
              color: '#1d4ed8',
              border: '1px solid rgba(29,78,216,.2)',
              borderRadius: 4,
              padding: '2px 7px',
            }}
          >
            PM
          </span>
        )}
        <span className={`badge ${jobStatus.badge}`}>{jobStatus.label}</span>
        {isLive && (
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              color: '#16a34a',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: '#16a34a',
                display: 'inline-block',
              }}
            />{' '}
            live
          </span>
        )}
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 10,
            color: 'var(--muted2)',
          }}
        >
          {job.component_code} · {job.goal_time}h goal
        </span>
        <button
          className="btn btn-sm"
          onClick={() => setEditing(!editing)}
          style={{
            background: editing ? 'var(--surface2)' : 'var(--red-dim)',
            border: `1px solid ${editing ? 'var(--border2)' : 'var(--accent)'}`,
            color: editing ? 'var(--muted)' : 'var(--accent)',
            fontWeight: 600,
            fontFamily: 'var(--mono)',
          }}
        >
          {editing ? '✕ cancel' : '✎ Edit Job'}
        </button>
        {jobIsEmpty && !editing && (
          <button
            className="btn btn-sm"
            onClick={deleteJob}
            title="Delete this job (no time, no parts)"
            style={{
              background: 'transparent',
              border: '1px solid var(--border2)',
              color: 'var(--muted)',
              fontWeight: 600,
              fontFamily: 'var(--mono)',
              marginLeft: 6,
            }}
          >
            🗑 Delete
          </button>
        )}
      </div>

      {/* Edit form */}
      {editing && (
        <div
          style={{
            padding: '14px 16px',
            background: 'rgba(0,0,0,.02)',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}
          >
            <div className="form-group" style={{ gridColumn: '1/-1' }}>
              <div className="form-label">Complaint</div>
              <input
                className="input"
                value={complaint}
                onChange={(e) => setComplaint(e.target.value)}
                placeholder="Driver complaint…"
              />
            </div>
            <div className="form-group" style={{ gridColumn: '1/-1' }}>
              <div className="form-label">Cause</div>
              <textarea
                className="textarea"
                value={cause}
                onChange={(e) => setCause(e.target.value)}
                rows={2}
                placeholder="What was actually wrong…"
              />
            </div>
            <div className="form-group" style={{ gridColumn: '1/-1' }}>
              <div className="form-label">Correction</div>
              <input
                className="select"
                style={{ width: '100%' }}
                list={`srt-jobs-${job.id}`}
                placeholder="Type a few letters… e.g. compressor, regen, unlisted"
                value={correction}
                onChange={(e) => onCorrectionInput(e.target.value)}
              />
              <datalist id={`srt-jobs-${job.id}`}>
                {(() => {
                  // In-order word matching: typed words must match consecutive
                  // words of the label, in sequence; last word may be partial.
                  // Leading digits = optional system-code filter ("013 cham").
                  let toks = correction.toLowerCase().split(/\s+/).filter(Boolean);
                  let sysFilter = null;
                  if (toks.length && /^\d/.test(toks[0])) { sysFilter = toks[0]; toks = toks.slice(1); }
                  const seqMatch = (words) => {
                    for (let i2 = 0; i2 + toks.length <= words.length; i2++) {
                      let ok = true;
                      for (let k = 0; k < toks.length; k++) {
                        const isLast = k === toks.length - 1;
                        if (isLast ? !words[i2 + k].startsWith(toks[k]) : words[i2 + k] !== toks[k]) { ok = false; break; }
                      }
                      if (ok) return true;
                    }
                    return false;
                  };
                  const matches = (label) => {
                    if (!toks.length) return true;
                    const lower = label.toLowerCase();
                    // pass A: special chars invisible inside words ("a/c" -> "ac")
                    const wordsA = lower.split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, '')).filter(Boolean);
                    // pass B: special chars act as separators ("self-powered" -> "self","powered")
                    const wordsB = lower.split(/[^a-z0-9]+/).filter(Boolean);
                    return seqMatch(wordsA) || seqMatch(wordsB);
                  };
                  return srtResults
                    .filter((sj) => (!sysFilter || (sj.system_code || '').startsWith(sysFilter)) && matches(sj.label))
                    .sort((a, b) => (a.system_code || '999').localeCompare(b.system_code || '999') || a.label.localeCompare(b.label))
                    .slice(0, 100)
                    .map((sj) => (
                      <option key={sj.id} value={sj.label} label={`${sj.system_code || '—'} · ${sj.label}`} />
                    ));
                })()}
              </datalist>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: srtJobId ? 'var(--green)' : 'var(--muted2)', marginTop: 4 }}>
                {srtJobId
                  ? `✓ catalog job · ${compCode}${srtGoal ? ` · est ${srtGoal}h` : ''}`
                  : correction
                  ? 'custom correction (not in catalog)'
                  : `${srtResults.length.toLocaleString()} jobs searchable`}
              </div>

              {/* ── BROWSE TREE: Group → System → Job (assemblies >10 jobs collapse) ── */}
              <button type="button" className="btn btn-sm"
                style={{ marginTop: 6, fontSize: 11 }}
                onClick={() => setShowBrowse((v) => !v)}>
                {showBrowse ? '▾ Hide job browser' : '▸ Browse jobs by system'}
              </button>
              {showBrowse && (
                <div style={{ marginTop: 6, border: '1px solid var(--border2)', borderRadius: 'var(--radius-md)', maxHeight: 320, overflowY: 'auto', background: 'var(--white)', fontSize: 12 }}>
                  {(() => {
                    // group the taxonomy
                    const groups = [];
                    const seen = {};
                    srtSystems.forEach((s) => {
                      if (!seen[s.group_code]) { seen[s.group_code] = { group_code: s.group_code, group_name: s.group_name, systems: [] }; groups.push(seen[s.group_code]); }
                      seen[s.group_code].systems.push(s);
                    });
                    const pick = (sj) => { setCorrection(sj.label); applySrtPick(sj); };
                    return groups.map((g) => (
                      <div key={g.group_code}>
                        <div onClick={() => setOpenGroup(openGroup === g.group_code ? null : g.group_code)}
                          style={{ padding: '7px 10px', cursor: 'pointer', fontFamily: 'var(--mono)', fontWeight: 600, background: 'var(--surface2)', borderBottom: '1px solid var(--border)' }}>
                          {openGroup === g.group_code ? '▾' : '▸'} {g.group_code} · {g.group_name}
                        </div>
                        {openGroup === g.group_code && g.systems.map((sys) => {
                          const sysJobs = srtResults.filter((j) => j.system_code === sys.system_code);
                          return (
                            <div key={sys.system_code}>
                              <div onClick={() => setOpenSystem(openSystem === sys.system_code ? null : sys.system_code)}
                                style={{ padding: '6px 10px 6px 22px', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}>
                                {openSystem === sys.system_code ? '▾' : '▸'} {sys.system_code} · {sys.name}
                                <span style={{ color: 'var(--muted2)', fontFamily: 'var(--mono)', fontSize: 10, marginLeft: 6 }}>({sysJobs.length})</span>
                              </div>
                              {openSystem === sys.system_code && (() => {
                                // group this system's jobs by component_code (assembly)
                                const asm = {}; const order = [];
                                sysJobs.forEach((j) => { const k = j.component_code || sys.system_code; if (!asm[k]) { asm[k] = []; order.push(k); } asm[k].push(j); });
                                return order.map((code) => {
                                  const jobs = asm[code];
                                  // assembly with >10 jobs collapses by default
                                  if (jobs.length > 10) {
                                    const isOpen = openAssembly === code;
                                    return (
                                      <div key={code}>
                                        <div onClick={() => setOpenAssembly(isOpen ? null : code)}
                                          style={{ padding: '5px 10px 5px 36px', cursor: 'pointer', color: 'var(--accent2)', fontFamily: 'var(--mono)', fontSize: 11 }}>
                                          {isOpen ? '▾' : '▸'} {code} <span style={{ color: 'var(--muted2)' }}>({jobs.length} jobs — click to expand)</span>
                                        </div>
                                        {isOpen && jobs.map((j) => (
                                          <div key={j.id} onClick={() => pick(j)}
                                            style={{ padding: '5px 10px 5px 50px', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}>
                                            {j.label}<span style={{ color: 'var(--muted2)', fontFamily: 'var(--mono)', fontSize: 10, marginLeft: 6 }}>{j.base_srt_hours ? `${j.base_srt_hours}h` : ''}</span>
                                          </div>
                                        ))}
                                      </div>
                                    );
                                  }
                                  // small assembly: show jobs directly
                                  return jobs.map((j) => (
                                    <div key={j.id} onClick={() => pick(j)}
                                      style={{ padding: '5px 10px 5px 36px', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}>
                                      {j.label}<span style={{ color: 'var(--muted2)', fontFamily: 'var(--mono)', fontSize: 10, marginLeft: 6 }}>{j.component_code || ''} {j.base_srt_hours ? `· ${j.base_srt_hours}h` : ''}</span>
                                    </div>
                                  ));
                                });
                              })()}
                            </div>
                          );
                        })}
                      </div>
                    ));
                  })()}
                </div>
              )}
            </div>
            <div className="form-group">
              <div className="form-label">Component</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 12, padding: '7px 12px', background: 'var(--white)', border: '1px solid var(--border2)', borderRadius: 'var(--radius-md)', color: compCode ? 'var(--text)' : 'var(--muted2)', minWidth: 110 }}>
                {compCode || 'auto from job'}
              </div>
            </div>
            <div className="form-group">
              <div className="form-label">Goal Time (h)</div>
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 12,
                  padding: '7px 12px',
                  background: 'var(--white)',
                  border: '1px solid var(--border2)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--text)',
                  width: 'fit-content',
                  minWidth: 80,
                }}
              >
                {(srtGoal ?? job.goal_time) || 0}h
              </div>
            </div>

            {!isTech && (
            <div className="form-group">
              <div className="form-label">Status</div>
              <select
                className="select"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                style={{ width: '100%' }}
              >
                {Object.entries(JOB_STATUS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
            )}
          </div>
          {histWarn && (
            <div style={{ gridColumn: '1/-1', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, background: 'var(--amber-dim)', border: '1px solid var(--amber)', fontSize: 12, color: 'var(--amber)' }}>
              ⚠ Historically this job averages ${histWarn.avg.toLocaleString()} ({histWarn.n} past jobs) — above the ${Math.round(mgrLimit).toLocaleString()} approval limit. Consider requesting approval with an estimate.
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => { setTireDraft(null); setEditing(false); }}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={saveJob}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save Job'}
            </button>
          </div>
        </div>
      )}

      {/* 3Cs read view */}
      {!editing && (
        <div
          style={{
            padding: '12px 16px',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 12,
            borderBottom: '1px solid var(--border)',
          }}
        >
          {[
            ['Cause', job.cause],
            ['Correction', job.correction],
            ['Component', job.component_code],
          ].map(([l, v]) => (
            <div key={l}>
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 9,
                  color: 'var(--muted2)',
                  textTransform: 'uppercase',
                  letterSpacing: '.06em',
                  marginBottom: 4,
                }}
              >
                {l}
              </div>
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  color: v ? 'var(--text)' : 'var(--muted2)',
                  fontStyle: v ? 'normal' : 'italic',
                }}
              >
                {v || 'Not entered'}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Outside RO: bubble of replaced tire positions + installed brand.
          Reads the local draft while one exists (unsaved selection this session),
          otherwise the committed job_parts rows. */}
      {isOutside && (() => {
        const committed = (parts || []).filter((p) => p.tire_position);
        const positions = tireDraft ? tireDraft.positions : committed.map((p) => p.tire_position);
        const brand = tireDraft ? tireDraft.brand : (committed.find((p) => p.tire_brand)?.tire_brand || '');
        if (!positions.length) return null;
        return (
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 8, padding: '10px 14px', borderRadius: 'var(--radius-md)', background: 'var(--red-dim)', border: '1px solid var(--border2)', maxWidth: '100%' }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted2)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                🛞 Tires replaced
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {positions.map((pos) => (
                  <span key={pos} style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, color: 'var(--text)', background: 'var(--white)', border: '1px solid var(--border2)', borderRadius: 'var(--radius-sm)', padding: '3px 8px' }}>
                    {TIRE_POS_LABEL(pos)}
                  </span>
                ))}
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)' }}>
                Brand installed: <b>{brand || '—'}</b>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Time + clock buttons */}
      <div
        style={{
          padding: '10px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          borderBottom: '1px solid var(--border)',
          flexWrap: 'wrap',
        }}
      >
        {!isOutside && (
          <button
            className="btn btn-sm"
            style={{
              background: 'var(--green-dim)',
              borderColor: 'rgba(22,163,74,.3)',
              color: 'var(--green)',
            }}
            onClick={clockIn}
          >
            ▶ Clock In
          </button>
        )}
        {!isOutside && (
          <button
            className="btn btn-sm"
            style={{
              background: 'var(--amber-dim)',
              borderColor: 'rgba(217,119,6,.3)',
              color: 'var(--amber)',
            }}
            onClick={clockOut}
          >
            ⏸ Clock Out
          </button>
        )}
        {!['finished', 'denied'].includes(job.status) && (
          <button
            className="btn btn-sm"
            style={{
              background: 'var(--green-dim)',
              borderColor: 'rgba(22,163,74,.4)',
              color: 'var(--green)',
              fontWeight: 600,
            }}
            onClick={finishJob}
          >
            ✓ Finish Job
          </button>
        )}
        {job.approved && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 9, color: 'var(--green)', background: 'var(--green-dim)', border: '1px solid var(--green)' }}>
            ✓ APPROVED{job.approved_by_name ? ` · ${job.approved_by_name}` : ''}
          </span>
        )}
        {job.status === 'waiting' && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 9, color: 'var(--amber)', background: 'var(--amber-dim)', border: '1px solid var(--amber)' }}>
            🔏 AWAITING APPROVAL{job.estimate_total ? ` · $${Math.round(job.estimate_total).toLocaleString()}` : ''}
          </span>
        )}
        {!isTech && job.status === 'inprogress' && !job.approved && (
          <button className="btn btn-ghost btn-sm" onClick={() => { setEstInput(String(Math.round(jobCost) || '')); setReqApproval(true); }}>
            🔏 Request Approval
          </button>
        )}
        {!isOutside && (
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setShowTimePopup(true)}
          style={{ marginLeft: 4 }}
        >
          {isLive ? (
            <span style={{ color: '#16a34a' }}>
              ● {fmtMins(totalTime)} · {timeEntries.length} entr
              {timeEntries.length === 1 ? 'y' : 'ies'} · since{' '}
              {fmtDateTime(timeEntries.find((e) => !e.clock_out)?.clock_in)}
            </span>
          ) : (
            <span>
              {fmtMins(totalTime)} · {timeEntries.length} entr
              {timeEntries.length === 1 ? 'y' : 'ies'} · last{' '}
              {fmtDateTime(timeEntries[timeEntries.length - 1]?.clock_in)}
            </span>
          )}
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 9,
              color: 'var(--muted2)',
              marginLeft: 4,
            }}
          >
            ↗
          </span>
        </button>
        )}
        {overGoal && (
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              color: 'var(--amber)',
              background: 'var(--amber-dim)',
              border: '1px solid rgba(217,119,6,.25)',
              borderRadius: 4,
              padding: '2px 8px',
            }}
          >
            {(() => {
              const over = Math.round((totalTime / 60 - job.goal_time) * 60);
              const h = Math.floor(over / 60);
              const m = over % 60;
              return `⚠ ${h > 0 ? h + 'h ' : ''}${m}m over goal`;
            })()}
          </span>
        )}
        {job.flag_no_parts && (
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              color: 'var(--amber)',
              background: 'var(--amber-dim)',
              border: '1px solid rgba(217,119,6,.25)',
              borderRadius: 4,
              padding: '2px 8px',
            }}
          >
            ⚠ No parts charged
          </span>
        )}
        {job.kickback_notes && (
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              color: 'var(--accent)',
              background: 'var(--red-dim)',
              border: '1px solid rgba(142,0,0,.2)',
              borderRadius: 4,
              padding: '2px 8px',
            }}
          >
            ↩ {job.kickback_notes}
          </span>
        )}
      </div>

      {/* Parts (inside only — outside parts are entered in the RO summary) */}
      {!isOutside && (
      <div style={{ padding: '10px 16px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 7,
          }}
        >
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              color: 'var(--muted2)',
              textTransform: 'uppercase',
              letterSpacing: '.06em',
            }}
          >
            Parts{parts.length > 0 ? ` · ${fmtCurrency(partsTotal)}` : ''}
          </span>
          <button
            className="btn btn-sm"
            onClick={() => setShowAddPart(true)}
            style={{ fontSize: 11, fontWeight: 600, background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', padding: '5px 11px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}
          >
            🔧 Add Part
          </button>
        </div>
        {parts.length === 0 && (
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--muted2)',
            }}
          >
            No parts added yet
          </div>
        )}
        {parts.map((p) => (
          <div
            key={p.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '5px 0',
              borderBottom: '1px solid var(--border)',
              fontSize: 12,
              fontFamily: 'var(--mono)',
            }}
          >
            <span
              style={{
                color: 'var(--muted2)',
                width: 100,
                flexShrink: 0,
                fontSize: 10,
              }}
            >
              {p.part_number || '—'}
            </span>
            <span style={{ flex: 1, color: 'var(--text)' }}>{p.part_name}</span>
            <span
              style={{ color: 'var(--muted2)', width: 24, textAlign: 'center' }}
            >
              ×{p.quantity}
            </span>
            <span style={{ fontWeight: 500, width: 72, textAlign: 'right' }}>
              {fmtCurrency(p.total_cost)}
            </span>
            {!isTech && (
              <button
                onClick={() => deletePart(p.id)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--muted2)',
                  fontSize: 12,
                  padding: '0 2px',
                }}
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
      )}

      {/* Failure photos — mapped to this job; shared with Recovery/Warranty */}
      <div style={{ padding: '10px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted2)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
            Photos{photos.length > 0 ? ` · ${photos.length}` : ''}
          </span>
          <label className="btn btn-sm" style={{ fontSize: 11, fontWeight: 600, cursor: uploadingPhoto ? 'wait' : 'pointer', opacity: uploadingPhoto ? 0.7 : 1, background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', padding: '5px 11px', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {uploadingPhoto ? 'Uploading…' : '📷 Add Photo'}
            <input type="file" accept="image/*" disabled={uploadingPhoto}
              style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadPhoto(f); }} />
          </label>
        </div>
        {photos.length === 0 ? (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)' }}>No photos added yet</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {photos.map((ph) => (
              <div key={ph.id} style={{ position: 'relative', width: 84, height: 84, borderRadius: 'var(--radius-sm)', overflow: 'hidden', border: '1px solid var(--border2)' }}>
                <a href={photoUrl(ph.storage_path)} target="_blank" rel="noopener noreferrer" style={{ display: 'block', width: '100%', height: '100%' }}>
                  <img src={photoUrl(ph.storage_path)} alt="failure" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </a>
                {!isTech && (
                  <button onClick={() => hidePhoto(ph.id)} title="Remove from job (file is kept)"
                    style={{ position: 'absolute', top: 2, right: 2, width: 18, height: 18, borderRadius: '50%', border: 'none', background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 11, lineHeight: '18px', cursor: 'pointer', padding: 0 }}>
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {reqApproval && (
        <div onClick={(e) => e.target === e.currentTarget && setReqApproval(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 600, padding: 16 }}>
          <div style={{ background: 'var(--white)', border: '1px solid var(--border2)', borderTop: '3px solid var(--amber)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)', width: '100%', maxWidth: 380, padding: '18px 20px' }}>
            <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 14, marginBottom: 4 }}>🔏 Request approval — J{job.job_number}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>Current cost ${Math.round(jobCost).toLocaleString()} (parts + {laborRate}/hr labor). Job pauses until approved.</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted2)', textTransform: 'uppercase', marginBottom: 4 }}>Official estimate ($)</div>
            <input type="number" className="input" value={estInput} onChange={(e) => setEstInput(e.target.value)} style={{ marginBottom: 10 }} />
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted2)', textTransform: 'uppercase', marginBottom: 4 }}>Notes</div>
            <textarea className="input" rows={3} value={estNotes} onChange={(e) => setEstNotes(e.target.value)} placeholder="Why this needs approval…" style={{ marginBottom: 14, resize: 'none' }} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setReqApproval(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={requestApproval}>Submit for Approval</button>
            </div>
          </div>
        </div>
      )}
      {dialog && (
        <div
          onClick={(e) => e.target === e.currentTarget && setDialog(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 600,
            padding: 16,
          }}
        >
          <div
            style={{
              background: 'var(--white)',
              border: '1px solid var(--border2)',
              borderTop: '3px solid var(--accent)',
              borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-lg)',
              width: '100%',
              maxWidth: 360,
              padding: '18px 20px',
            }}
          >
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontWeight: 700,
                fontSize: 14,
                color: 'var(--text)',
                marginBottom: 8,
              }}
            >
              {dialog.title}
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 16 }}>
              {dialog.text}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {dialog.type === 'confirm' && (
                <button className="btn" onClick={() => setDialog(null)}>
                  Cancel
                </button>
              )}
              <button
                className="btn btn-primary"
                onClick={() => (dialog.type === 'confirm' ? dialog.onOk() : setDialog(null))}
              >
                {dialog.type === 'confirm' ? '✓ Finish Job' : 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
      {showTimePopup && (
        <TimeEntriesPopup
          entries={timeEntries}
          jobTitle={`J${job.job_number} — ${job.complaint?.slice(0, 40)}`}
          onClose={() => setShowTimePopup(false)}
        />
      )}
      {tirePopup && (
        <OutsideTirePopup
          posClass={tirePopup.posClass}
          onCancel={clearTireCorrection}
          onSave={saveOutsideTires}
        />
      )}
      {showAddPart && (
        <AddPartPopup
          jobId={job.id}
          jobComponentCode={compCode || job.component_code}
          unitInfo={null}
          ro={ro}
          user={user}
          onClose={() => setShowAddPart(false)}
          onSave={() => {
            load();
            onSave();
          }}
        />
      )}
    </div>
  );
}

// ── MAIN RO PAGE ──────────────────────────────────────────────
export default function ROPage({ ro, onBack, user, isTech, kind, readOnly = false }) {
  _setROReadOnly(readOnly);
  // An RO is either an inside RO (ro_headers) or an outside RO (outside_ros).
  // They render through the SAME page; outside adds vendor/invoice/cost fields,
  // a fillable labor+parts summary, an invoice upload, and hides the shop-floor
  // job mechanics (clock in/out, timer, per-job add-part).
  const isOutside = (kind === 'outside') || (ro && ('vendor_name' in ro || 'date_sent' in ro) && !('opened_date' in ro));
  const RO_TABLE = isOutside ? 'outside_ros' : 'ro_headers';
  const [jobs, setJobs] = useState([]);
  const [finishBlockers, setFinishBlockers] = useState(null); // string[] of missing requirements
  const [addingJob, setAddingJob] = useState(false);
  const [newComplaint, setNewComplaint] = useState('');
  const [savingJob, setSavingJob] = useState(false);
  const [notes, setNotes] = useState((isOutside ? ro.current_notes : ro.general_notes) || '');
  const [roData, setRoData] = useState(ro);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [billTo, setBillTo] = useState(ro.bill_to || '');
  const [billLocations, setBillLocations] = useState([]);  // {id,code,name} from locations, company-scoped
  const [billToVerify, setBillToVerify] = useState(false); // pool-unit suggestion needs confirming

  // ── RO ATTACHMENTS (general docs/photos, any RO type) ──────────
  // Files live in the existing 'unit-documents' bucket under ro/{ro_id}/...
  // Rows in ro_attachments. Distinct from the invoice upload on outside ROs.
  const ATTACH_BUCKET = 'unit-documents';
  const [attachments, setAttachments] = useState([]);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const loadAttachments = useCallback(async () => {
    const { data } = await sb.from('ro_attachments').select('*').eq('ro_id', ro.id).order('created_at', { ascending: false });
    setAttachments(data || []);
  }, [ro.id]);
  useEffect(() => { loadAttachments(); }, [loadAttachments]);
  async function openAttachment(path) {
    try {
      const { data } = await sb.storage.from(ATTACH_BUCKET).createSignedUrl(path, 3600);
      if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    } catch (e) { alert('Could not open file: ' + (e?.message || e)); }
  }
  async function uploadAttachment(file) {
    if (!file) return;
    setUploadingDoc(true);
    try {
      const co = roData.company_id || user?.company_id || 'no-co';
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `ro/${ro.id}/${Date.now()}_${safe}`;
      const { error: upErr } = await sb.storage.from(ATTACH_BUCKET).upload(path, file, { upsert: false, contentType: file.type || 'application/octet-stream' });
      if (upErr) { alert('Upload failed: ' + upErr.message); return; }
      const { error: rowErr } = await sb.from('ro_attachments').insert({
        ro_id: ro.id, company_id: roData.company_id || user?.company_id || null,
        doc_name: file.name, storage_path: path,
        file_size_kb: Math.max(1, Math.round(file.size / 1024)),
        uploaded_by: user?.id || null, uploaded_by_name: user?.name || user?.email || null,
      });
      if (rowErr) { alert('File uploaded but linking failed: ' + rowErr.message); return; }
      await loadAttachments();
    } finally { setUploadingDoc(false); }
  }
  async function removeAttachment(att) {
    if (!confirm('Remove "' + att.doc_name + '" from this RO?')) return;
    try {
      if (att.storage_path) await sb.storage.from(ATTACH_BUCKET).remove([att.storage_path]);
      await sb.from('ro_attachments').delete().eq('id', att.id);
      await loadAttachments();
    } catch (e) { alert('Could not remove: ' + (e?.message || e)); }
  }

  // ── OUTSIDE-ONLY FIELDS ────────────────────────────────────────
  // Vendor, invoice #, cost blocks (final/tax/shipping/fees), fillable
  // labor + parts $ (no clock-in to derive them), and the invoice upload.
  // All persist to outside_ros. Saved on blur to avoid a write per keystroke.
  const INVOICE_BUCKET = 'vault-invoices';
  const [outFields, setOutFields] = useState({
    vendor_name: ro.vendor_name || '',
    vendor_invoice_number: ro.vendor_invoice_number || '',
    final_cost: ro.final_cost ?? '',
    invoice_tax: ro.invoice_tax ?? '',
    invoice_shipping: ro.invoice_shipping ?? '',
    invoice_fees: ro.invoice_fees ?? '',
    out_labor_cost: ro.out_labor_cost ?? '',   // informational breakdown only
    out_parts_cost: ro.out_parts_cost ?? '',   // informational breakdown only
  });
  const [uploadingInvoice, setUploadingInvoice] = useState(false);
  const [scanningInvoice, setScanningInvoice] = useState(false);
  function setOut(k, v) { setOutFields((p) => ({ ...p, [k]: v })); }
  // Final Cost is DERIVED (not AI, not hand-typed): labor + parts + tax + shipping + fees.
  function computedFinal() {
    const num = (x) => Number(x) || 0;
    return num(outFields.out_labor_cost) + num(outFields.out_parts_cost)
      + num(outFields.invoice_tax) + num(outFields.invoice_shipping) + num(outFields.invoice_fees);
  }

  async function saveOutField(k) {
    if (!isOutside) return;
    const v = outFields[k];
    const numCols = ['final_cost', 'invoice_tax', 'invoice_shipping', 'invoice_fees', 'out_labor_cost', 'out_parts_cost'];
    const val = numCols.includes(k) ? (v === '' ? null : v) : (v || null);
    const patch = { [k]: val };
    // editing any of the five components recomputes + persists Final Cost (flows to Vault)
    const components = ['out_labor_cost', 'out_parts_cost', 'invoice_tax', 'invoice_shipping', 'invoice_fees'];
    if (components.includes(k)) {
      const fin = computedFinal();
      patch.final_cost = fin;
      setOut('final_cost', fin);
    }
    await sb.from(RO_TABLE).update(patch).eq('id', ro.id);
  }

  // Mark the RO finished. Outside ROs run blocker checks first; inside ROs finish directly.
  async function markRoFinished() {
    if (isOutside) {
      const missing = [];
      if (!String(outFields.vendor_name || '').trim()) missing.push('Vendor');
      if (!String(outFields.vendor_invoice_number || '').trim()) missing.push('Invoice #');
      if (!(computedFinal() > 0)) missing.push('Final Cost (enter Labor / Parts / Tax / Ship / Fees)');
      if (!roData.invoice_object_key) missing.push('Invoice file uploaded');
      const open = (jobs || []).filter((j) => !['finished', 'denied'].includes(j.status));
      if (open.length) missing.push(`All jobs finished (${open.length} still open)`);
      if (missing.length) { setFinishBlockers(missing); return; }
    }
    const finCol = isOutside ? 'date_finished' : 'finished_date'; // outside_ros vs ro_headers
    await sb.from(RO_TABLE)
      .update({ status: 'finished', [finCol]: new Date().toISOString() })
      .eq('id', ro.id);
    setRoData((p) => ({ ...p, status: 'finished' }));
    load();
  }

  // read a File as a bare base64 string (no data: prefix)
  function fileToBase64(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(',')[1] || '');
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
  }

  async function uploadInvoice(file) {
    if (!file) return;
    setUploadingInvoice(true);
    try {
      const co = roData.company_id || user?.company_id || 'no-co';
      const safe = (outFields.vendor_invoice_number || 'inv').replace(/[^a-zA-Z0-9_-]/g, '_');
      const path = `${co}/${roData.location_id}/outro_${Date.now()}_${safe}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const { error: upErr } = await sb.storage.from(INVOICE_BUCKET).upload(path, file, { upsert: false });
      if (upErr) { alert('Invoice upload failed: ' + upErr.message); return; }
      await sb.from(RO_TABLE).update({ invoice_object_key: path }).eq('id', ro.id);
      setRoData((p) => ({ ...p, invoice_object_key: path }));
    } finally { setUploadingInvoice(false); }

    // AI scan-to-fill: invoice #, labor, parts, tax, shipping, fees. Overwrites any
    // existing values. Best-effort — a scan failure never blocks the upload.
    try {
      setScanningInvoice(true);
      const mt = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : 'image/jpeg');
      const b64 = await fileToBase64(file);
      const resp = await fetch('/api/scan-invoice', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file_base64: b64, media_type: mt,
          meta: {
            company_id: roData.company_id || user?.company_id || null,
            company_name: roData.company_name || null,
            user_id: user?.id || null, user_name: user?.name || user?.email || null, user_role: user?.role || null,
            ro_number: roData.ro_number || null,
          },
        }),
      });
      const out = await resp.json();
      if (out && out.fields) {
        const f = out.fields;
        // map scanned fields -> outFields columns; only overwrite when a value came back
        const patch = {};
        if (f.invoice_number != null) patch.vendor_invoice_number = String(f.invoice_number);
        if (f.labor != null) patch.out_labor_cost = f.labor;
        if (f.parts != null) patch.out_parts_cost = f.parts;
        if (f.tax != null) patch.invoice_tax = f.tax;
        if (f.shipping != null) patch.invoice_shipping = f.shipping;
        if (f.fees != null) patch.invoice_fees = f.fees;
        if (Object.keys(patch).length) {
          // recompute Final Cost from the freshly-scanned components and persist it too
          const num = (x) => Number(x) || 0;
          patch.final_cost = num(patch.out_labor_cost ?? outFields.out_labor_cost)
            + num(patch.out_parts_cost ?? outFields.out_parts_cost)
            + num(patch.invoice_tax ?? outFields.invoice_tax)
            + num(patch.invoice_shipping ?? outFields.invoice_shipping)
            + num(patch.invoice_fees ?? outFields.invoice_fees);
          setOutFields((p) => ({ ...p, ...patch }));
          await sb.from(RO_TABLE).update(patch).eq('id', ro.id);
          setRoData((p) => ({ ...p, ...patch }));
        }
      } else if (out && out.error) {
        // surface only the actionable cases; otherwise stay quiet (manual entry still works)
        if (out.error === 'no_api_key') alert('Invoice scan is not connected yet (no API key set). You can enter the amounts manually.');
      }
    } catch (e) {
      /* scan failed silently — manual entry remains available */
    } finally {
      setScanningInvoice(false);
    }
  }
  async function openInvoice() {
    if (!roData.invoice_object_key) return;
    try {
      const { data } = await sb.storage.from(INVOICE_BUCKET).createSignedUrl(roData.invoice_object_key, 3600);
      if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    } catch (e) { alert('Could not open invoice: ' + (e?.message || e)); }
  }

  const load = useCallback(async () => {
    let lq = sb.from('locations').select('id,code,name,is_pool').order('code').range(0, 999);
    if (user?.company_id) lq = lq.eq('company_id', user.company_id);
    const [jRes, rRes, lRes] = await Promise.all([
      sb.from('ro_jobs').select('*').eq('ro_id', ro.id).order('job_number'),
      sb.from(RO_TABLE).select('*').eq('id', ro.id).single(),
      lq,
    ]);
    const jobsData = jRes.data || [];
    const header = rRes.data || roData;
    const locs = (lRes.data || []).filter((l) => l.code);
    setJobs(jobsData);
    if (rRes.data) setRoData(rRes.data);
    setBillLocations(locs);

    // ── BILL TO AUTO-FILL ──────────────────────────────────────
    // Rule: bill_to ALWAYS defaults to the unit's DOMICILED location.
    // If the unit has no real domicile (pool / Shared Fleet, is_pool=true),
    // leave bill_to empty so the user is FORCED to pick a real location
    // (the pool location is never an option in the dropdown). Never clobber
    // a manual choice — only fill when empty.
    // NOTE: resolve the unit by unit_number + company_id, NOT unit_id — newly
    // created ROs can have a null unit_id, which previously made domiciled
    // units fall through and wrongly show as "pool".
    if (!header.bill_to && (header.unit_number || header.unit_id)) {
      const codeForLocId = (locId) =>
        locId ? (locs.find((l) => l.id === locId)?.code || '') : '';
      const isPoolLoc = (locId) =>
        !locId || !!locs.find((l) => l.id === locId)?.is_pool;
      try {
        let unit = null;
        if (header.unit_number) {
          let uq = sb.from('units').select('id,location_id').eq('unit_number', header.unit_number);
          if (user?.company_id) uq = uq.eq('company_id', user.company_id);
          const r = await uq.maybeSingle();
          unit = r.data;
        }
        if (!unit && header.unit_id) {
          const r = await sb.from('units').select('id,location_id').eq('id', header.unit_id).maybeSingle();
          unit = r.data;
        }
        if (unit && !isPoolLoc(unit.location_id)) {
          // Domiciled — bill to its home location, silently.
          const suggestion = codeForLocId(unit.location_id);
          if (suggestion) {
            setBillTo(suggestion);
            setBillToVerify(false);
            await sb
              .from('ro_headers')
              .update({ bill_to: suggestion })
              .eq('id', ro.id);
          }
        }
        // Pool unit (or no resolvable unit) → leave empty; prompt forces a pick.
      } catch {}
    }
    setLoading(false);
  }, [ro.id, user?.company_id]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveNotes() {
    setSaving(true);
    await sb
      .from(RO_TABLE)
      .update(isOutside ? { current_notes: notes } : { general_notes: notes })
      .eq('id', ro.id);
    setSaving(false);
  }

  // Delete the entire RO — only when status is not-started AND no job carries
  // any time or parts (per the rule, no parts inherently means no time).
  // Re-checks live before deleting, then cascades children client-side:
  // job_photos -> ro_jobs -> ro_attachments -> ro_headers.
  // Inside ROs: deletable only while Not Started. Outside ROs: deletable until an
  // invoice/cost has been attached (no invoice number and no stored invoice file).
  // Inside: deletable only while Not Started (+ no time/parts, checked live below).
  // Outside: deletable any time BEFORE it is reviewed (i.e. before it has been sent to
  // the Vault). This supports "reject -> SM fixes or deletes the erroneous RO". Once
  // reviewed/closed it is an AP record and cannot be deleted here.
  const roDeletable = isOutside
    ? !['reviewed', 'closed'].includes(roData.status)
    : (roData.status === 'open' || roData.status === 'not_started');
  async function deleteRO() {
    // live guard: any time or parts on ANY job blocks deletion
    const jobIds = jobs.map((j) => j.id);
    if (!isOutside && jobIds.length) {
      const [{ count: tCount }, { count: pCount }] = await Promise.all([
        sb.from('job_time_entries').select('*', { count: 'exact', head: true }).in('job_id', jobIds),
        sb.from('job_parts').select('*', { count: 'exact', head: true }).in('job_id', jobIds),
      ]);
      if ((tCount || 0) > 0 || (pCount || 0) > 0) {
        alert('This RO has time or parts logged and can no longer be deleted.');
        load();
        return;
      }
    }
    if (!isOutside && !(roData.status === 'open' || roData.status === 'not_started')) {
      alert('Only a Not Started RO can be deleted.');
      load();
      return;
    }
    if (isOutside && ['reviewed', 'closed'].includes(roData.status)) {
      alert('This RO has been reviewed and sent to the Vault; it can no longer be deleted here.');
      load();
      return;
    }
    if (!confirm('Delete Repair Order ' + roData.ro_number + ' and its ' + jobs.length + ' job' + (jobs.length === 1 ? '' : 's') + '? This cannot be undone.')) return;
    try {
      // photos for each job (storage + rows)
      if (jobIds.length) {
        const { data: phs } = await sb.from('job_photos').select('storage_path').in('job_id', jobIds);
        const paths = (phs || []).map((p) => p.storage_path).filter(Boolean);
        if (paths.length) { try { await sb.storage.from('inspection-photos').remove(paths); } catch {} }
        await sb.from('job_photos').delete().in('job_id', jobIds);
      }
      // RO-level attachments (storage + rows)
      const { data: atts } = await sb.from('ro_attachments').select('storage_path').eq('ro_id', ro.id);
      const attPaths = (atts || []).map((a) => a.storage_path).filter(Boolean);
      if (attPaths.length) { try { await sb.storage.from('unit-documents').remove(attPaths); } catch {} }
      await sb.from('ro_attachments').delete().eq('ro_id', ro.id);
      // parts (incl. outside tire records), then jobs, then the header (correct table)
      if (jobIds.length) await sb.from('job_parts').delete().in('job_id', jobIds);
      await sb.from('ro_jobs').delete().eq('ro_id', ro.id);
      const { error } = await sb.from(RO_TABLE).delete().eq('id', ro.id);
      if (error) throw error;
      onBack();
    } catch (e) { alert('Delete failed: ' + (e?.message || e)); }
  }

  // Open the inline add-job box (no window.prompt — it is blocked in the
  // StackBlitz/Netlify iframe sandbox, which is what made "Add Job" silently fail).
  function addJob() {
    setNewComplaint('');
    setAddingJob(true);
  }

  async function saveNewJob() {
    const c = (newComplaint || '').trim();
    if (!c) { setAddingJob(false); return; }
    setSavingJob(true);
    try {
      // job_number = max existing + 1 (never array length — a prior delete leaves
      // gaps and length+1 can collide → 409). Re-read live to avoid a stale count.
      const { data: cur, error: rErr } = await sb
        .from('ro_jobs').select('job_number').eq('ro_id', ro.id);
      if (rErr) throw rErr;
      const nextNum = (cur || []).reduce((m, j) => Math.max(m, Number(j.job_number) || 0), 0) + 1;
      const { error: iErr } = await sb.from('ro_jobs').insert({
        ro_id: ro.id,
        job_number: nextNum,
        complaint: c,
        status: 'not_started',
        ro_kind: isOutside ? 'outside' : 'inside',
      });
      if (iErr) throw iErr;
      if (!isOutside && roData.is_new) {
        await sb.from('ro_headers').update({ is_new: false }).eq('id', ro.id);
      }
      setAddingJob(false);
      setNewComplaint('');
      await load();
    } catch (e) {
      alert('Could not add job: ' + (e?.message || e));
    } finally {
      setSavingJob(false);
    }
  }

  // Totals — Actual is ALWAYS the live sum of job hours (never the header
  // rollup, which can hold stale values and shadow the goal time)
  const totalHours = jobs.reduce((s, j) => s + (j.total_hours || 0), 0);
  const totalParts = jobs.reduce((s, j) => s + (j.parts_total || 0), 0);
  const totalGoal = jobs.reduce((s, j) => s + (Number(j.goal_time) || 0), 0);
  const flags = jobs.filter(
    (j) => j.flag_no_parts || j.flag_labor || j.kickback_notes
  );
  const allDone =
    jobs.length > 0 &&
    jobs.every((j) => ['finished', 'denied'].includes(j.status));

  const statusColor =
    {
      open: 'var(--muted2)',
      inprogress: '#1d4ed8',
      finished: '#d97706',
      reviewed: '#16a34a',
      closed: 'var(--muted)',
    }[roData.status] || 'var(--muted2)';

  const statusLabel =
    {
      open: 'Not Started',
      inprogress: 'In Progress',
      finished: 'Finished',
      reviewed: 'Reviewed',
      closed: 'Closed',
    }[roData.status] || roData.status;

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--page-bg)',
      }}
    >
      {/* ── HEADER ────────────────────────────────────────── */}
      <div
        style={{
          background: 'var(--white)',
          borderBottom: '1px solid var(--border)',
          padding: '12px 20px',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 8,
            flexWrap: 'wrap',
          }}
        >
          <button
            className="btn btn-ghost btn-sm"
            onClick={onBack}
            style={{ display: 'flex', alignItems: 'center', gap: 5 }}
          >
            ← Back
          </button>
          <div style={{ width: 1, height: 20, background: 'var(--border)' }} />
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--muted2)',
            }}
          >
            Repair Order #
          </div>
          <div
            style={{ fontFamily: 'var(--mono)', fontSize: 17, fontWeight: 600 }}
          >
            {roData.ro_number}
          </div>
          <div style={{ width: 1, height: 20, background: 'var(--border)' }} />
          <a
            href={`${window.location.origin}/?${(() => { try { const u = JSON.parse(sessionStorage.getItem('al_session_user')); return u ? 'shell_user=' + btoa(JSON.stringify(u)) + '&' : ''; } catch { return ''; } })()}tab=units&unit=${encodeURIComponent(roData.unit_number || '')}`}
            target="_blank"
            rel="noopener noreferrer"
            title="Open this unit's file in a new tab"
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 17,
              fontWeight: 600,
              color: 'var(--accent)',
              textDecoration: 'none',
              borderBottom: '2px dotted var(--accent)',
              paddingBottom: 1,
              cursor: 'pointer',
              transition: 'var(--transition)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.7'; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
          >
            #{roData.unit_number} ↗
          </a>
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 11,
              padding: '3px 10px',
              borderRadius: 20,
              border: `1px solid ${statusColor}20`,
              color: statusColor,
              background: `${statusColor}10`,
            }}
          >
            {statusLabel}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {!isTech && (isOutside ? !['finished', 'reviewed', 'closed', 'denied'].includes(roData.status) : allDone) && (
              <button
                className="btn btn-primary btn-sm"
                onClick={markRoFinished}
              >
                ✓ Mark Finished
              </button>
            )}
            {roDeletable && (
              <button
                className="btn btn-sm"
                onClick={deleteRO}
                title="Delete this RO (Not Started, no parts or time)"
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border2)',
                  color: 'var(--muted)',
                  fontWeight: 600,
                  fontFamily: 'var(--mono)',
                }}
              >
                🗑 Delete RO
              </button>
            )}
          </div>
        </div>

        {finishBlockers && (
          <div onClick={(e) => e.target === e.currentTarget && setFinishBlockers(null)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
            <div onClick={(e) => e.stopPropagation()}
              style={{ background: 'var(--white)', borderRadius: 'var(--radius-lg)', padding: 22, width: 'min(440px, 92vw)', boxShadow: 'var(--shadow-lg)' }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>Can&rsquo;t finish this RO yet</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)', marginBottom: 12 }}>
                The following are required before this RO can be finished:
              </div>
              <ul style={{ margin: '0 0 16px', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {finishBlockers.map((m, i) => (
                  <li key={i} style={{ fontSize: 13, color: 'var(--text)' }}>{m}</li>
                ))}
              </ul>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn btn-primary btn-sm" onClick={() => setFinishBlockers(null)}>Got it</button>
              </div>
            </div>
          </div>
        )}
        <div
          style={{
            display: 'flex',
            gap: 20,
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--muted2)',
            flexWrap: 'wrap',
          }}
        >
          {roData.vin && <span>VIN: {roData.vin}</span>}
          {isOutside ? (
            <>
              <span>Sent: {fmtDate(roData.date_sent)}</span>
              {roData.vendor_name && <span>Vendor: {roData.vendor_name}</span>}
              {roData.eta && <span>ETA: {fmtDate(roData.eta)}</span>}
            </>
          ) : (
            <>
              <span>Opened: {fmtDate(roData.opened_date)}</span>
              <span>By: {roData.opened_by_name || '—'}</span>
            </>
          )}
          {(isOutside ? roData.date_finished : roData.finished_date) && (
            <span>Finished: {fmtDate(isOutside ? roData.date_finished : roData.finished_date)}</span>
          )}
          {flags.length > 0 && (
            <span style={{ color: 'var(--amber)' }}>
              ⚠ {flags.length} flag{flags.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      {/* ── BODY ──────────────────────────────────────────── */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          display: 'grid',
          gridTemplateColumns: '1fr 280px',
          gap: 0,
          alignItems: 'start',
        }}
      >
        {/* Left — jobs (both RO types; outside cards auto-trim labor-hours + inventory parts) */}
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 12,
            }}
          >
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                color: 'var(--muted2)',
                textTransform: 'uppercase',
                letterSpacing: '.08em',
              }}
            >
              Jobs · {jobs.length}
            </span>
            {!isTech && (
              <button
                className="btn btn-sm"
                onClick={addJob}
                style={{ background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', fontWeight: 600, padding: '6px 14px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}
              >
                + Add Job
              </button>
            )}
          </div>
          {addingJob && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0', padding: 10, border: '1px solid var(--border2)', borderRadius: 'var(--radius-sm)', background: 'var(--surface2)' }}>
              <input
                autoFocus
                value={newComplaint}
                onChange={(e) => setNewComplaint(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveNewJob(); if (e.key === 'Escape') { setAddingJob(false); setNewComplaint(''); } }}
                placeholder="Driver complaint / what's wrong…"
                style={{ flex: 1, padding: '8px 10px', border: '1px solid var(--border2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--sans)', fontSize: 13 }}
              />
              <button className="btn btn-sm" disabled={savingJob || !newComplaint.trim()} onClick={saveNewJob}
                style={{ background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', fontWeight: 600, padding: '8px 14px', cursor: 'pointer' }}>
                {savingJob ? 'Adding…' : 'Add'}
              </button>
              <button className="btn btn-sm" disabled={savingJob} onClick={() => { setAddingJob(false); setNewComplaint(''); }}
                style={{ background: 'transparent', border: '1px solid var(--border2)', color: 'var(--muted)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          )}
          {loading && (
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 12,
                color: 'var(--muted2)',
              }}
            >
              Loading…
            </div>
          )}
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              ro={roData}
              user={user}
              isTech={isTech}
              isOutside={isOutside}
              onSave={load}
            />
          ))}
          {!loading && jobs.length === 0 && (
            <div
              style={{
                padding: 24,
                textAlign: 'center',
                border: '1px dashed var(--border2)',
                borderRadius: 8,
              }}
            >
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 12,
                  color: 'var(--muted2)',
                  marginBottom: 12,
                }}
              >
                No jobs on this RO yet
              </div>
              {!isTech && (
                <button
                  className="btn btn-sm"
                  onClick={addJob}
                  style={{ background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', fontWeight: 600, padding: '8px 18px', cursor: 'pointer' }}
                >
                  + Add First Job
                </button>
              )}
            </div>
          )}
        </div>

        {/* Right — summary */}
        <div
          style={{
            borderLeft: '1px solid var(--border)',
            padding: 18,
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
            position: 'sticky',
            top: 0,
          }}
        >
          {/* Outside details — vendor, invoice #, costs, upload (outside ROs only) */}
          {isOutside && (
            <div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted2)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 10 }}>
                Outside Details
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <div className="form-label">Vendor</div>
                  <input className="input" style={{ width: '100%' }} value={outFields.vendor_name}
                    onChange={(e) => setOut('vendor_name', e.target.value)} onBlur={() => saveOutField('vendor_name')} />
                </div>
                <div>
                  <div className="form-label">Invoice #</div>
                  <input className="input" style={{ width: '100%' }} value={outFields.vendor_invoice_number}
                    onChange={(e) => setOut('vendor_invoice_number', e.target.value)} onBlur={() => saveOutField('vendor_invoice_number')} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <div className="form-label">Labor ($)</div>
                    <input className="input" type="number" style={{ width: '100%' }} value={outFields.out_labor_cost}
                      onChange={(e) => setOut('out_labor_cost', e.target.value)} onBlur={() => saveOutField('out_labor_cost')} />
                  </div>
                  <div>
                    <div className="form-label">Parts ($)</div>
                    <input className="input" type="number" style={{ width: '100%' }} value={outFields.out_parts_cost}
                      onChange={(e) => setOut('out_parts_cost', e.target.value)} onBlur={() => saveOutField('out_parts_cost')} />
                  </div>
                </div>
                <div>
                  <div className="form-label">Final Cost ($) <span style={{ color: 'var(--muted2)', fontWeight: 400 }}>— auto-sum, flows to Vault</span></div>
                  <input className="input" type="number" readOnly tabIndex={-1}
                    title="Auto-calculated: Labor + Parts + Tax + Shipping + Fees. Edit any of those to change it."
                    style={{ width: '100%', background: 'var(--page-bg)', color: 'var(--text)', fontWeight: 600, cursor: 'not-allowed' }}
                    value={computedFinal().toFixed(2)} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  <div>
                    <div className="form-label">Tax ($)</div>
                    <input className="input" type="number" style={{ width: '100%' }} value={outFields.invoice_tax}
                      onChange={(e) => setOut('invoice_tax', e.target.value)} onBlur={() => saveOutField('invoice_tax')} />
                  </div>
                  <div>
                    <div className="form-label">Ship ($)</div>
                    <input className="input" type="number" style={{ width: '100%' }} value={outFields.invoice_shipping}
                      onChange={(e) => setOut('invoice_shipping', e.target.value)} onBlur={() => saveOutField('invoice_shipping')} />
                  </div>
                  <div>
                    <div className="form-label">Fees ($)</div>
                    <input className="input" type="number" style={{ width: '100%' }} value={outFields.invoice_fees}
                      onChange={(e) => setOut('invoice_fees', e.target.value)} onBlur={() => saveOutField('invoice_fees')} />
                  </div>
                </div>
                <div>
                  <div className="form-label">Invoice File</div>
                  {roData.invoice_object_key ? (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <button className="btn btn-sm" onClick={openInvoice} style={{ flex: 1 }}>📄 View invoice</button>
                      <label className="btn btn-sm" style={{ cursor: uploadingInvoice ? 'wait' : 'pointer' }}>
                        {uploadingInvoice ? '…' : 'Replace'}
                        <input type="file" disabled={uploadingInvoice} style={{ display: 'none' }}
                          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadInvoice(f); }} />
                      </label>
                    </div>
                  ) : (
                    <label className="btn btn-sm" style={{ width: '100%', justifyContent: 'center', cursor: uploadingInvoice ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      {uploadingInvoice ? 'Uploading…' : '+ Upload Invoice'}
                      <input type="file" disabled={uploadingInvoice} style={{ display: 'none' }}
                        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadInvoice(f); }} />
                    </label>
                  )}
                  {scanningInvoice && (
                    <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent)' }}>
                      <style>{'@keyframes aiScanSpin{to{transform:rotate(360deg)}}'}</style>
                      <span style={{ width: 12, height: 12, border: '2px solid var(--border2)', borderTopColor: 'var(--accent)', borderRadius: '50%', display: 'inline-block', animation: 'aiScanSpin 0.8s linear infinite' }} />
                      Reading invoice with AI…
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Stats */}
          <div>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                color: 'var(--muted2)',
                textTransform: 'uppercase',
                letterSpacing: '.08em',
                marginBottom: 10,
              }}
            >
              Summary
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 8,
              }}
            >
              {(isOutside
                ? [
                    ['Jobs', jobs.length],
                    ['Labor', fmtCurrency(Number(outFields.out_labor_cost) || 0)],
                    ['Parts', fmtCurrency(Number(outFields.out_parts_cost) || 0)],
                    ['Final', fmtCurrency(computedFinal())],
                  ]
                : [
                ['Jobs', jobs.length],
                ['Goal', totalGoal.toFixed(1) + 'h'],
                [
                  'Actual',
                  totalHours.toFixed(1) +
                    'h' +
                    (jobs.some((j) => j.status === 'inprogress') ? ' ●' : ''),
                ],
                ['Parts', fmtCurrency(totalParts)],
              ]).map(([l, v]) => (
                <div
                  key={l}
                  style={{
                    background: 'var(--page-bg)',
                    borderRadius: 7,
                    padding: '10px 12px',
                    border: '1px solid var(--border)',
                  }}
                >
                  <div
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 18,
                      fontWeight: 300,
                    }}
                  >
                    {v}
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 9,
                      color: 'var(--muted2)',
                      marginTop: 2,
                    }}
                  >
                    {l}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Cost breakdown */}
          <div>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                color: 'var(--muted2)',
                textTransform: 'uppercase',
                letterSpacing: '.08em',
                marginBottom: 10,
              }}
            >
              Cost
            </div>
            {(isOutside
              ? (() => {
                  const labor = Number(outFields.out_labor_cost) || 0;
                  const partsC = Number(outFields.out_parts_cost) || 0;
                  const tax = Number(outFields.invoice_tax) || 0;
                  const ship = Number(outFields.invoice_shipping) || 0;
                  const fees = Number(outFields.invoice_fees) || 0;
                  return [
                    ['Labor', fmtCurrency(labor)],
                    ['Parts', fmtCurrency(partsC)],
                    ['Tax / Ship / Fees', fmtCurrency(tax + ship + fees)],
                    ['Total', fmtCurrency(labor + partsC + tax + ship + fees)],
                  ];
                })()
              : [
              ['Labor (actual)', `${totalHours.toFixed(1)}h`],
              ['Parts', fmtCurrency(totalParts)],
              ['Total', fmtCurrency(totalParts)],
            ]).map(([l, v], i, arr) => (
              <div
                key={l}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '6px 0',
                  borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none',
                  fontFamily: 'var(--mono)',
                  fontSize: i === arr.length - 1 ? 13 : 12,
                  fontWeight: i === arr.length - 1 ? 500 : 400,
                }}
              >
                <span
                  style={{ color: i < arr.length - 1 ? 'var(--muted2)' : 'var(--text)' }}
                >
                  {l}
                </span>
                <span>{v}</span>
              </div>
            ))}
          </div>

          {/* Bill To — inside ROs only (outside bill via vendor invoice/Vault) */}
          {!isOutside && (
          <div>
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  color: 'var(--muted2)',
                  textTransform: 'uppercase',
                  letterSpacing: '.08em',
                  marginBottom: 8,
                }}
              >
                Bill To
              </div>
              <select
                className="select"
                style={{ width: '100%' }}
                value={billTo}
                onChange={async (e) => {
                  setBillTo(e.target.value);
                  setBillToVerify(false); // manual choice = confirmed
                  await sb
                    .from('ro_headers')
                    .update({ bill_to: e.target.value })
                    .eq('id', ro.id);
                }}
              >
                <option value="">— Select location —</option>
                {billLocations.filter((l) => !l.is_pool).map((l) => (
                  <option key={l.id} value={l.code}>{l.code} — {l.name}</option>
                ))}
              </select>
              {!billTo && (
                <div
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    color: 'var(--amber)',
                    marginTop: 5,
                  }}
                >
                  ⚠ Pool unit — no home terminal. Select a billing location.
                </div>
              )}
          </div>
          )}
          {/* Notes */}
          <div>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                color: 'var(--muted2)',
                textTransform: 'uppercase',
                letterSpacing: '.08em',
                marginBottom: 8,
              }}
            >
              Notes
            </div>
            <textarea
              className="textarea"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="General notes about this RO…"
              style={{ fontSize: 11 }}
            />
            <button
              className="btn btn-sm"
              onClick={saveNotes}
              disabled={saving}
              style={{ marginTop: 6, float: 'right' }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <div style={{ clear: 'both' }} />
          </div>

          {/* Attachments */}
          <div>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                color: 'var(--muted2)',
                textTransform: 'uppercase',
                letterSpacing: '.08em',
                marginBottom: 8,
              }}
            >
              Attachments
            </div>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--muted2)',
              }}
            >
              Documents or photos for this RO (PDF, image, or file).
            </div>
            {attachments.length > 0 && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {attachments.map((att) => (
                  <div key={att.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--white)' }}>
                    <button onClick={() => openAttachment(att.storage_path)}
                      title="Open file"
                      style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      📎 {att.doc_name}
                    </button>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted2)' }}>{att.file_size_kb ? att.file_size_kb + ' KB' : ''}</span>
                    <button onClick={() => removeAttachment(att)}
                      title="Remove from this RO"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 12, color: 'var(--muted2)' }}>✕</button>
                  </div>
                ))}
              </div>
            )}
            <label
              className="btn btn-sm"
              style={{ marginTop: 8, width: '100%', justifyContent: 'center', cursor: uploadingDoc ? 'wait' : 'pointer', opacity: uploadingDoc ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 5 }}
            >
              {uploadingDoc ? 'Uploading…' : '+ Upload File'}
              <input type="file" disabled={uploadingDoc}
                style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadAttachment(f); }} />
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}


/* ───────── Outside RO: replace-tire capture ─────────
   Fires when a replace-tire correction (017-001..004) is picked on an OUTSIDE RO.
   Asks which positions were replaced (smart-filtered to the job's class) and the
   brand installed. Saves to job_parts (Option A). DOT/tread/removed-brand are not
   captured for outside work. */
function OutsideTirePopup({ posClass, onCancel, onSave }) {
  const POS = {
    steer: [['steer_left','Steer Left'],['steer_right','Steer Right']],
    drive: [['drive_1_left_outer','Drive 1 L Outer'],['drive_1_left_inner','Drive 1 L Inner'],['drive_1_right_inner','Drive 1 R Inner'],['drive_1_right_outer','Drive 1 R Outer'],['drive_2_left_outer','Drive 2 L Outer'],['drive_2_left_inner','Drive 2 L Inner'],['drive_2_right_inner','Drive 2 R Inner'],['drive_2_right_outer','Drive 2 R Outer'],['drive_1_left_ss','Drive 1 L (SS)'],['drive_1_right_ss','Drive 1 R (SS)'],['drive_2_left_ss','Drive 2 L (SS)'],['drive_2_right_ss','Drive 2 R (SS)']],
    trailer: [['trailer_1_left_outer','Trlr 1 L Outer'],['trailer_1_left_inner','Trlr 1 L Inner'],['trailer_1_right_inner','Trlr 1 R Inner'],['trailer_1_right_outer','Trlr 1 R Outer'],['trailer_2_left_outer','Trlr 2 L Outer'],['trailer_2_left_inner','Trlr 2 L Inner'],['trailer_2_right_inner','Trlr 2 R Inner'],['trailer_2_right_outer','Trlr 2 R Outer'],['trailer_3_left_outer','Trlr 3 L Outer'],['trailer_3_left_inner','Trlr 3 L Inner'],['trailer_3_right_inner','Trlr 3 R Inner'],['trailer_3_right_outer','Trlr 3 R Outer'],['trailer_1_left_ss','Trlr 1 L (SS)'],['trailer_1_right_ss','Trlr 1 R (SS)'],['trailer_2_left_ss','Trlr 2 L (SS)'],['trailer_2_right_ss','Trlr 2 R (SS)'],['trailer_3_left_ss','Trlr 3 L (SS)'],['trailer_3_right_ss','Trlr 3 R (SS)']],
  };
  const opts = posClass === 'any' ? [...POS.steer, ...POS.drive, ...POS.trailer] : (POS[posClass] || []);
  const [picked, setPicked] = React.useState([]);
  const [brand, setBrand] = React.useState('');
  const toggle = (v) => setPicked((p) => p.includes(v) ? p.filter((x) => x !== v) : [...p, v]);
  const canSave = picked.length > 0 && brand.trim();
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onCancel()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--white)', borderRadius: 'var(--radius-lg)', padding: 20, width: 'min(560px, 92vw)', maxHeight: '88vh', overflow: 'auto', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>🛞 Replaced tires</div>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>✕</button>
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)', marginBottom: 14 }}>
          {posClass === 'any' ? 'All positions' : posClass + ' positions only'} · select every position the vendor replaced
        </div>

        <div className="form-label">Positions replaced *</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 6, margin: '6px 0 16px' }}>
          {opts.map(([v, l]) => {
            const on = picked.includes(v);
            return (
              <button key={v} type="button" onClick={() => toggle(v)}
                style={{ textAlign: 'left', padding: '8px 10px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 12,
                  border: '1px solid ' + (on ? 'var(--accent)' : 'var(--border2)'),
                  background: on ? 'var(--red-dim)' : 'var(--white)', color: 'var(--text)', fontWeight: on ? 600 : 400 }}>
                {on ? '☑ ' : '☐ '}{l}
              </button>
            );
          })}
        </div>

        <div className="form-label">Brand installed *</div>
        <input className="input" list="outside-tire-brands" value={brand} onChange={(e) => setBrand(e.target.value)}
          placeholder="type 2 letters to filter, or pick…" autoComplete="off" style={{ width: '100%', marginTop: 4 }} />
        <datalist id="outside-tire-brands">
          {MAJOR_TIRE_BRANDS.map((b) => <option key={b} value={b} />)}
        </datalist>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button className="btn btn-sm" onClick={onCancel}
            style={{ background: 'transparent', border: '1px solid var(--border2)', color: 'var(--muted)' }}>Cancel</button>
          <button className="btn btn-sm" disabled={!canSave} onClick={() => onSave(picked, brand.trim())}
            style={{ background: canSave ? 'var(--accent)' : 'var(--border2)', color: '#fff', border: '1px solid ' + (canSave ? 'var(--accent)' : 'var(--border2)') }}>
            Save {picked.length || ''} tire{picked.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}
