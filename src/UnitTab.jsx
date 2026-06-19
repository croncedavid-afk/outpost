import React, { useState, useEffect, useCallback, useRef } from 'react';
import { sb } from './supabase.js';
import ROPage from './ROPage.jsx';

// ── HELPERS ───────────────────────────────────────────────────
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
function daysSince(d) {
  return d ? Math.floor((Date.now() - new Date(d)) / 86400000) : 999;
}
function daysUntil(d) {
  return d ? Math.ceil((new Date(d) - Date.now()) / 86400000) : null;
}

function PMStatusBadge({ days, miles, intervalDays, intervalMiles }) {
  const daysPct = intervalDays > 0 ? days / intervalDays : 0;
  const milesPct = intervalMiles > 0 ? miles / intervalMiles : 0;
  const pct = Math.max(daysPct, milesPct);
  if (pct >= 1) return <span className="badge badge-red">Overdue</span>;
  if (pct >= 0.8) return <span className="badge badge-amber">Due Soon</span>;
  return <span className="badge badge-green">Current</span>;
}

// ── IMAGE COMPRESSION ─────────────────────────────────────────
async function compressImage(file, maxKB = 300) {
  if (!file.type.startsWith('image/')) return file;
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      let { width, height } = img;
      const MAX = 1920;
      if (width > MAX || height > MAX) {
        if (width > height) {
          height = Math.round((height * MAX) / width);
          width = MAX;
        } else {
          width = Math.round((width * MAX) / height);
          height = MAX;
        }
      }
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      let quality = 0.85;
      const tryCompress = () => {
        canvas.toBlob(
          (blob) => {
            if (blob.size / 1024 > maxKB && quality > 0.3) {
              quality -= 0.1;
              tryCompress();
            } else {
              resolve(new File([blob], file.name, { type: 'image/jpeg' }));
            }
          },
          'image/jpeg',
          quality
        );
      };
      tryCompress();
    };
    img.src = url;
  });
}

// ── UNIT LIST ─────────────────────────────────────────────────
function UnitList({ locationId, onSelect, user }) {
  const [units, setUnits] = useState([]);
  const [search, setSearch] = useState('');
  const [typeFilter, setType] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Load ALL units for this company — search overrides location filter
    let uq = sb.from('units').select('*').eq('status', 'active');
    if (user?.company_id) uq = uq.eq('company_id', user.company_id);
    uq.order('unit_number').range(0, 49999)
      .then(({ data }) => {
        setUnits(data || []);
        setLoading(false);
      });
  }, [user?.company_id]);

  const filtered = units.filter((u) => {
    const q = search.toLowerCase();
    const matchQ =
      !q ||
      u.unit_number?.toLowerCase().includes(q) ||
      u.vin?.toLowerCase().includes(q);
    const matchT =
      !typeFilter ||
      u.unit_type === typeFilter ||
      u.unit_subtype === typeFilter;
    // When searching, show all locations; otherwise filter to current location
    const matchL = q ? true : !locationId || u.location_id === locationId;
    return matchQ && matchT && matchL;
  });

  const types = [
    ...new Set(units.map((u) => u.unit_subtype || u.unit_type).filter(Boolean)),
  ].sort();

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '10px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexShrink: 0,
          background: 'var(--white)',
        }}
      >
        <span
          style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 500 }}
        >
          Units
        </span>
        <input
          className="input"
          placeholder="Search unit # or VIN…"
          value={search}
          list="unit-recent-searches"
          onChange={(e) => setSearch(e.target.value)}
          onBlur={() => pushRecent('al_recent_unit_search', search)}
          onKeyDown={(e) => { if (e.key === 'Enter') pushRecent('al_recent_unit_search', search); }}
          style={{ width: 220 }}
        />
        <datalist id="unit-recent-searches">
          {getRecents('al_recent_unit_search').map((s) => <option key={s} value={s} />)}
        </datalist>
        <select
          className="select"
          value={typeFilter}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="">All Types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--muted2)',
            marginLeft: 'auto',
          }}
        >
          {filtered.length} units
        </span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && (
          <div
            style={{
              padding: 40,
              textAlign: 'center',
              fontFamily: 'var(--mono)',
              fontSize: 12,
              color: 'var(--muted2)',
            }}
          >
            Loading…
          </div>
        )}
        <table className="data-table">
          <thead>
            <tr>
              {[
                'Unit #',
                'Type',
                'Year/Make/Model',
                'VIN',
                'Mileage',
                'Status',
                '',
              ].map((h) => (
                <th key={h}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr
                key={u.id}
                onClick={() => onSelect(u)}
                style={{ cursor: 'pointer' }}
              >
                <td
                  style={{
                    padding: '10px 14px',
                    fontFamily: 'var(--mono)',
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  {u.unit_number}
                </td>
                <td
                  style={{
                    padding: '10px 14px',
                    fontFamily: 'var(--mono)',
                    fontSize: 11,
                    color: 'var(--muted2)',
                  }}
                >
                  {u.unit_subtype || u.unit_type || '—'}
                </td>
                <td
                  style={{
                    padding: '10px 14px',
                    fontFamily: 'var(--mono)',
                    fontSize: 11,
                  }}
                >
                  {[u.year, u.make, u.model].filter(Boolean).join(' ') || '—'}
                </td>
                <td
                  style={{
                    padding: '10px 14px',
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    color: 'var(--muted2)',
                  }}
                >
                  {u.vin || '—'}
                </td>
                <td
                  style={{
                    padding: '10px 14px',
                    fontFamily: 'var(--mono)',
                    fontSize: 11,
                  }}
                >
                  {u.mileage ? u.mileage.toLocaleString() + ' mi' : '—'}
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <span
                    className={`badge ${
                      u.status === 'active' ? 'badge-green' : 'badge-gray'
                    }`}
                  >
                    {u.status || '—'}
                  </span>
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <button className="btn btn-sm"
                    style={{ background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)',
                      borderRadius: 'var(--radius-sm)', fontWeight: 600, padding: '6px 14px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    View →
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── UNIT PROFILE ──────────────────────────────────────────────
function UnitProfile({ unit: initialUnit, onBack, user }) {
  const [activeTab, setActiveTab] = useState('info');
  const [unit, setUnit] = useState(initialUnit);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [roPage, setRoPage] = useState(null);

  function reloadUnit() {
    sb.from('units')
      .select('*')
      .eq('id', unit.id)
      .single()
      .then(({ data }) => {
        if (data) setUnit(data);
      });
  }

  function startEdit() {
    setEditForm({
      unit_number: unit.unit_number || '',
      year: unit.year || '',
      make: unit.make || '',
      model: unit.model || '',
      vin: unit.vin || '',
      mileage: unit.mileage || '',
      tire_size: unit.tire_size || '',
      engine_model: unit.engine_model || '',
      transmission_model: unit.transmission_model || '',
      axle_config: unit.axle_config || '',
      reefer_make: unit.reefer_make || '',
      reefer_model: unit.reefer_model || '',
      apu_make: unit.apu_make || '',
      apu_model: unit.apu_model || '',
      color: unit.color || '',
      license_plate: unit.license_plate || '',
      license_state: unit.license_state || '',
      notes: unit.notes || '',
    });
    setEditing(true);
  }

  async function saveEdit() {
    await sb.from('units').update(editForm).eq('id', unit.id);
    setEditing(false);
    reloadUnit();
  }

  if (roPage)
    return (
      <ROPage
        ro={roPage}
        user={user}
        isTech={false}
        readOnly={readOnly}
        kind={roPage && ('date_sent' in roPage || 'vendor_name' in roPage) && !('opened_date' in roPage) ? 'outside' : 'inside'}
        onBack={() => setRoPage(null)}
      />
    );

  const TABS = [
    { id: 'info', label: 'Info' },
    { id: 'pm', label: 'PM Schedule' },
    { id: 'history', label: 'Repair History' },
    { id: 'accessories', label: 'Accessories' },
    { id: 'documents', label: 'Documents' },
    { id: 'warranty', label: 'Warranty' },
    { id: 'spend', label: 'Spend' },
  ];

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
      {/* Header */}
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
          }}
        >
          <button className="btn btn-ghost btn-sm" onClick={onBack}>
            ← Units
          </button>
          <div style={{ width: 1, height: 20, background: 'var(--border)' }} />
          <div
            style={{ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 700 }}
          >
            #{unit.unit_number}
          </div>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 13,
              color: 'var(--muted2)',
            }}
          >
            {[unit.year, unit.make, unit.model].filter(Boolean).join(' ')}
          </div>
          <span
            className={`badge ${
              unit.status === 'active' ? 'badge-green' : 'badge-gray'
            }`}
          >
            {unit.status}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {!editing && (
              <button className="btn btn-sm" onClick={startEdit}>
                Edit Info
              </button>
            )}
          </div>
        </div>
        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 2, marginTop: 4 }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              style={{
                padding: '5px 14px',
                border: 'none',
                borderRadius: 0,
                background: 'transparent',
                cursor: 'pointer',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: activeTab === t.id ? 'var(--accent)' : 'var(--muted)',
                borderBottom:
                  activeTab === t.id
                    ? '2px solid var(--accent)'
                    : '2px solid transparent',
                transition: 'all .15s',
                fontWeight: activeTab === t.id ? 500 : 400,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {activeTab === 'info' && (
          <InfoTab
            unit={unit}
            editing={editing}
            editForm={editForm}
            setEditForm={setEditForm}
            onSave={saveEdit}
            onCancel={() => setEditing(false)}
          />
        )}
        {activeTab === 'pm' && <PMTab unit={unit} />}
        {activeTab === 'history' && (
          <HistoryTab unit={unit} onOpenRO={setRoPage} />
        )}
        {activeTab === 'accessories' && (
          <AccessoriesTab unit={unit} user={user} />
        )}
        {activeTab === 'documents' && <DocumentsTab unit={unit} user={user} />}
        {activeTab === 'warranty' && <WarrantyTab unit={unit} user={user} />}
        {activeTab === 'spend' && <SpendTab unit={unit} user={user} />}
      </div>
    </div>
  );
}

// ── INFO TAB ──────────────────────────────────────────────────
function InfoTab({ unit, editing, editForm, setEditForm, onSave, onCancel }) {
  function set(k, v) {
    setEditForm((p) => ({ ...p, [k]: v }));
  }
  // Read this unit's location code + name from the locations table (not hardcoded —
  // covers St. Gabriel, LA, and all future customer locations).
  const [locInfo, setLocInfo] = useState({ code: null, name: null });
  useEffect(() => {
    let alive = true;
    if (unit?.location_id) {
      sb.from('locations').select('code,name').eq('id', unit.location_id).single()
        .then(({ data }) => { if (alive && data) setLocInfo({ code: data.code, name: data.name }); });
    }
    return () => { alive = false; };
  }, [unit?.location_id]);

  // Field groups -> each renders as its own card ("bubble").
  const groups = [
    { title: 'Identity', icon: '🚛', fields: [
      ['Unit Number', 'unit_number'],
      ['Year', 'year'],
      ['Make', 'make'],
      ['Model', 'model'],
      ['VIN', 'vin'],
      ['Color', 'color'],
    ] },
    { title: 'Specs', icon: '⚙️', fields: [
      ['Mileage', 'mileage'],
      ['Tire Size', 'tire_size'],
      ['Engine Model', 'engine_model'],
      ['Transmission', 'transmission_model'],
      ['Axle Config', 'axle_config'],
    ] },
    { title: 'Reefer & APU', icon: '❄️', fields: [
      ['Reefer Make', 'reefer_make'],
      ['Reefer Model', 'reefer_model'],
      ['APU Make', 'apu_make'],
      ['APU Model', 'apu_model'],
    ] },
    { title: 'Registration', icon: '📋', fields: [
      ['License Plate', 'license_plate'],
      ['License State', 'license_state'],
    ] },
  ];

  const labelStyle = {
    fontFamily: 'var(--mono)',
    fontSize: 9.5,
    color: 'var(--muted2)',
    textTransform: 'uppercase',
    letterSpacing: '.07em',
    marginBottom: 3,
  };
  const cardStyle = { padding: 16, display: 'flex', flexDirection: 'column', gap: 12 };
  const sectionHead = {
    fontFamily: 'var(--mono)',
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '.08em',
    color: 'var(--text)',
    paddingBottom: 8,
    marginBottom: 2,
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    gap: 7,
  };

  function FieldCell({ label, fieldKey }) {
    const raw = unit[fieldKey];
    const display = fieldKey === 'mileage' && raw ? raw.toLocaleString() + ' mi' : (raw || '—');
    const empty = !raw;
    return (
      <div>
        <div style={labelStyle}>{label}</div>
        {editing ? (
          <input className="input" value={editForm[fieldKey] || ''} onChange={(e) => set(fieldKey, e.target.value)} />
        ) : (
          <div style={{
            fontFamily: 'var(--mono)',
            fontSize: 13,
            fontWeight: empty ? 400 : 500,
            color: empty ? 'var(--muted2)' : 'var(--text)',
          }}>
            {display}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: 20, maxWidth: 900 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, alignItems: 'start' }}>
        {/* Home Location — featured first, full attention */}
        <div className="card" style={cardStyle}>
          <div style={sectionHead}><span>📍</span> Home Location</div>
          {unit.location_id ? (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>
                {locInfo.code || unit.location_id}
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--text)' }}>
                {locInfo.name || unit.location_id}
              </span>
            </div>
          ) : (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--muted2)' }}>—</div>
          )}
        </div>

        {/* Field group cards */}
        {groups.map((g) => (
          <div key={g.title} className="card" style={cardStyle}>
            <div style={sectionHead}><span>{g.icon}</span> {g.title}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px' }}>
              {g.fields.map(([label, key]) => (
                <FieldCell key={key} label={label} fieldKey={key} />
              ))}
            </div>
          </div>
        ))}

        {/* Notes — full width */}
        <div className="card" style={{ ...cardStyle, gridColumn: '1/-1' }}>
          <div style={sectionHead}><span>📝</span> Notes</div>
          {editing ? (
            <textarea className="textarea" value={editForm.notes || ''} onChange={(e) => set('notes', e.target.value)} rows={3} />
          ) : (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: unit.notes ? 'var(--text)' : 'var(--muted2)', whiteSpace: 'pre-wrap' }}>
              {unit.notes || '—'}
            </div>
          )}
        </div>
      </div>

      {editing && (
        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onSave}>
            Save Changes
          </button>
        </div>
      )}
      {/* GPS info */}
      {unit.lat && (
        <div
          style={{
            marginTop: 20,
            padding: '10px 14px',
            background: 'var(--white)',
            borderRadius: 8,
            border: '1px solid var(--border)',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--muted2)',
          }}
        >
          📍 Last GPS: {unit.lat?.toFixed(4)}, {unit.lng?.toFixed(4)} ·{' '}
          {unit.gps_source} · {fmtDate(unit.gps_updated_at)}
          {unit.on_route && (
            <span className="badge badge-blue" style={{ marginLeft: 8 }}>
              On Route
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── PM TAB ────────────────────────────────────────────────────
function PMTab({ unit }) {
  const [intervals, setIntervals] = useState([]);
  const [submissions, setSubmissions] = useState([]);

  useEffect(() => {
    Promise.all([
      sb
        .from('pm_intervals')
        .select('*')
        .eq('unit_subtype', unit.unit_subtype || unit.unit_type),
      sb
        .from('tech_pm_submissions')
        .select('*')
        .eq('unit_id', unit.id)
        .order('submitted_at', { ascending: false })
        .limit(20),
    ]).then(([iv, sub]) => {
      setIntervals(iv.data || []);
      setSubmissions(sub.data || []);
    });
  }, [unit.id]);

  const daysSincePM = daysSince(unit.last_pm_date);
  const milesSincePM =
    unit.mileage && unit.last_pm_mileage
      ? unit.mileage - unit.last_pm_mileage
      : 0;

  return (
    <div style={{ padding: 20 }}>
      {/* Current status */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4,1fr)',
          gap: 10,
          marginBottom: 20,
        }}
      >
        {[
          ['Last PM Date', fmtDate(unit.last_pm_date)],
          [
            'Days Since PM',
            daysSincePM === 999 ? 'No record' : daysSincePM + 'd',
          ],
          [
            'Last PM Mileage',
            unit.last_pm_mileage
              ? unit.last_pm_mileage.toLocaleString() + ' mi'
              : '—',
          ],
          [
            'Miles Since PM',
            milesSincePM > 0 ? milesSincePM.toLocaleString() + ' mi' : '—',
          ],
        ].map(([l, v]) => (
          <div
            key={l}
            style={{
              background: 'var(--white)',
              borderRadius: 8,
              padding: '12px 14px',
              border: '1px solid var(--border)',
            }}
          >
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 9,
                color: 'var(--muted2)',
                marginBottom: 4,
              }}
            >
              {l}
            </div>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 16,
                fontWeight: 300,
              }}
            >
              {v}
            </div>
          </div>
        ))}
      </div>

      {/* PM intervals */}
      {intervals.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span className="card-title">
              PM Intervals — {unit.unit_subtype || unit.unit_type}
            </span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {[
                  'Type',
                  'Interval (Days)',
                  'Interval (Miles)',
                  'Days Since',
                  'Miles Since',
                  'Status',
                ].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: '8px 14px',
                      textAlign: 'left',
                      fontFamily: 'var(--mono)',
                      fontSize: 10,
                      color: 'var(--muted2)',
                      fontWeight: 400,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {intervals.map((iv) => (
                <tr
                  key={iv.id}
                  style={{ borderBottom: '1px solid var(--border)' }}
                >
                  <td
                    style={{
                      padding: '10px 14px',
                      fontFamily: 'var(--mono)',
                      fontSize: 11,
                      fontWeight: 500,
                    }}
                  >
                    {iv.pm_type || iv.unit_subtype}
                  </td>
                  <td
                    style={{
                      padding: '10px 14px',
                      fontFamily: 'var(--mono)',
                      fontSize: 11,
                    }}
                  >
                    {iv.interval_days}d
                  </td>
                  <td
                    style={{
                      padding: '10px 14px',
                      fontFamily: 'var(--mono)',
                      fontSize: 11,
                    }}
                  >
                    {iv.interval_miles > 0
                      ? iv.interval_miles.toLocaleString() + ' mi'
                      : '—'}
                  </td>
                  <td
                    style={{
                      padding: '10px 14px',
                      fontFamily: 'var(--mono)',
                      fontSize: 11,
                    }}
                  >
                    {daysSincePM === 999 ? '—' : daysSincePM + 'd'}
                  </td>
                  <td
                    style={{
                      padding: '10px 14px',
                      fontFamily: 'var(--mono)',
                      fontSize: 11,
                    }}
                  >
                    {milesSincePM > 0
                      ? milesSincePM.toLocaleString() + ' mi'
                      : '—'}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <PMStatusBadge
                      days={daysSincePM}
                      miles={milesSincePM}
                      intervalDays={iv.interval_days}
                      intervalMiles={iv.interval_miles}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* PM History */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">PM History</span>
        </div>
        <div style={{ padding: '0' }}>
          {!submissions.length && (
            <div
              style={{
                padding: '16px 14px',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--muted2)',
              }}
            >
              No PM history found
            </div>
          )}
          {submissions.map((s) => (
            <div
              key={s.id}
              style={{
                padding: '10px 14px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  fontWeight: 500,
                }}
              >
                {fmtDate(s.submitted_at)}
              </span>
              <span
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  color: 'var(--muted2)',
                }}
              >
                {s.tech_name || '—'}
              </span>
              <span className="badge badge-green">Complete</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── REPAIR HISTORY TAB ────────────────────────────────────────
function HistoryTab({ unit, onOpenRO }) {
  const [ros, setRos] = useState([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatus] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [systemFilter, setSystemFilter] = useState('');
  const [codeFilter, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState('opened_date');
  const [sortDir, setSortDir] = useState('desc');
  const [expanded, setExpanded] = useState({}); // ro.id -> bool

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const [insideRes0, outsideRes, sysRes] = await Promise.all([
        sb.from('ro_headers').select('*')
          .eq('unit_number', unit.unit_number)
          .order('opened_date', { ascending: false }).range(0, 49999),
        sb.from('outside_ros').select('*')
          .eq('unit_number', unit.unit_number)
          .order('created_at', { ascending: false }),
        sb.from('srt_systems').select('system_code,name,group_code,group_name'),
      ]);
      // Attach jobs client-side (ro_headers->ro_jobs embed FK was removed for outside-RO jobs).
      const _ih = insideRes0.data || [];
      const _ihIds = _ih.map((h) => h.id);
      let _jByRo = {};
      if (_ihIds.length) {
        const { data: _jr } = await sb.from('ro_jobs').select('*').in('ro_id', _ihIds).range(0, 49999);
        (_jr || []).forEach((j) => { (_jByRo[j.ro_id] = _jByRo[j.ro_id] || []).push(j); });
      }
      const insideRes = { data: _ih.map((h) => ({ ...h, jobs: _jByRo[h.id] || [] })) };

      // system_code -> {systemName, groupCode, groupName}
      const sysMap = {};
      (sysRes.data || []).forEach((s) => {
        sysMap[s.system_code] = { systemName: s.name, groupCode: s.group_code, groupName: s.group_name };
      });

      const inside = (insideRes.data || []).map((r) => ({
        ...r,
        _ro_type: /^VNDR-/i.test(r.ro_number || '') ? 'vendor' : 'inside',
      }));
      const outside = (outsideRes.data || []).map((r) => ({
        ...r, _ro_type: 'outside', status: r.status || 'open',
        jobs: [], total_hours: 0, opened_date: r.created_at,
      }));
      const allRos = [...inside, ...outside];

      // Resolve each job's system/group authoritatively via srt_job_id -> srt_jobs.system_code
      // (SVC- codes map to many systems, so prefix alone is unreliable).
      const srtIds = [...new Set(allRos.flatMap((r) => (r.jobs || []).map((j) => j.srt_job_id).filter(Boolean)))];
      const srtSysById = {};
      if (srtIds.length) {
        for (let i = 0; i < srtIds.length; i += 300) {
          const chunk = srtIds.slice(i, i + 300);
          const { data } = await sb.from('srt_jobs').select('id,system_code').in('id', chunk);
          (data || []).forEach((s) => { srtSysById[s.id] = s.system_code; });
        }
      }
      const prefixOf = (cc) => (cc && /^[0-9]{3}-/.test(cc)) ? cc.slice(0, 3) : null;
      allRos.forEach((r) => {
        (r.jobs || []).forEach((j) => {
          const sc = srtSysById[j.srt_job_id] || prefixOf(j.component_code) || null;
          const m = sc ? sysMap[sc] : null;
          j._system_code = sc || null;
          j._system_name = m?.systemName || null;
          j._group_code = m?.groupCode || null;
          j._group_name = m?.groupName || null;
        });
        // Aggregate sets for filtering
        r._groups = [...new Set((r.jobs || []).map((j) => j._group_code).filter(Boolean))];
        r._systems = [...new Set((r.jobs || []).map((j) => j._system_code).filter(Boolean))];
        r._codes = [...new Set((r.jobs || []).map((j) => j.component_code).filter(Boolean))];
      });

      if (!alive) return;
      setRos(allRos);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [unit.unit_number]);

  // Build filter option lists from loaded data (group -> systems dependency)
  const groupOptions = [...new Map(ros.flatMap((r) => (r.jobs || [])
    .filter((j) => j._group_code).map((j) => [j._group_code, j._group_name]))).entries()]
    .sort((a, b) => a[0].localeCompare(b[0]));
  const systemOptions = [...new Map(ros.flatMap((r) => (r.jobs || [])
    .filter((j) => j._system_code && (!groupFilter || j._group_code === groupFilter))
    .map((j) => [j._system_code, j._system_name]))).entries()]
    .sort((a, b) => a[0].localeCompare(b[0]));
  const codeOptions = [...new Set(ros.flatMap((r) => (r.jobs || [])
    .filter((j) => j.component_code
      && (!groupFilter || j._group_code === groupFilter)
      && (!systemFilter || j._system_code === systemFilter))
    .map((j) => j.component_code)))].sort();

  const filtered = ros.filter((r) => {
    const q = search.toLowerCase();
    const matchQ = !q || (r.ro_number || '').toLowerCase().includes(q);
    const matchS = !statusFilter || r.status === statusFilter;
    const matchG = !groupFilter || (r._groups || []).includes(groupFilter);
    const matchSys = !systemFilter || (r._systems || []).includes(systemFilter);
    const matchC = !codeFilter || (r._codes || []).includes(codeFilter);
    return matchQ && matchS && matchG && matchSys && matchC;
  });

  const sorted = [...filtered].sort((a, b) => {
    let av, bv;
    switch (sortKey) {
      case 'ro_number': av = a.ro_number || ''; bv = b.ro_number || ''; return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      case 'type': av = a._ro_type; bv = b._ro_type; return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      case 'jobs': av = (a.jobs || []).length; bv = (b.jobs || []).length; break;
      case 'hours': av = a.total_hours || 0; bv = b.total_hours || 0; break;
      case 'status': av = a.status || ''; bv = b.status || ''; return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      case 'reviewed_date': av = a.reviewed_date ? new Date(a.reviewed_date) : 0; bv = b.reviewed_date ? new Date(b.reviewed_date) : 0; break;
      case 'opened_date':
      default: av = a.opened_date ? new Date(a.opened_date) : 0; bv = b.opened_date ? new Date(b.opened_date) : 0; break;
    }
    return sortDir === 'asc' ? av - bv : bv - av;
  });

  function toggleSort(key) {
    if (sortKey === key) { setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); }
    else { setSortKey(key); setSortDir(key === 'ro_number' || key === 'type' || key === 'status' ? 'asc' : 'desc'); }
  }
  const arrow = (key) => sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const cols = [
    ['', null, 34],                       // expand chevron
    ['RO #', 'ro_number', null],
    ['Type', 'type', null],
    ['Opened', 'opened_date', null],
    ['Reviewed', 'reviewed_date', null],
    ['Jobs', 'jobs', null],
    ['Hours', 'hours', null],
    ['Status', 'status', null],
    ['', null, 110],                      // open button
  ];

  const thBase = {
    padding: '9px 14px', textAlign: 'left', fontFamily: 'var(--mono)',
    fontSize: 10, color: 'var(--muted2)', fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '.05em',
    userSelect: 'none', whiteSpace: 'nowrap',
  };
  const tdBase = { padding: '9px 14px', fontFamily: 'var(--mono)', fontSize: 12, verticalAlign: 'middle' };

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input className="input" placeholder="Search RO #…" value={search}
          onChange={(e) => setSearch(e.target.value)} style={{ width: 160 }} />
        <select className="select" value={statusFilter} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All Statuses</option>
          {['open', 'inprogress', 'finished', 'reviewed'].map((s) => (
            <option key={s} value={s}>{s === 'open' ? 'Not Started' : s}</option>
          ))}
        </select>
        <select className="select" value={groupFilter}
          onChange={(e) => { setGroupFilter(e.target.value); setSystemFilter(''); setCode(''); }}>
          <option value="">All Groups</option>
          {groupOptions.map(([code, name]) => (
            <option key={code} value={code}>{code} — {name}</option>
          ))}
        </select>
        <select className="select" value={systemFilter}
          onChange={(e) => { setSystemFilter(e.target.value); setCode(''); }}>
          <option value="">All Systems</option>
          {systemOptions.map(([code, name]) => (
            <option key={code} value={code}>{code} — {name}</option>
          ))}
        </select>
        <select className="select" value={codeFilter} onChange={(e) => setCode(e.target.value)}>
          <option value="">All Codes</option>
          {codeOptions.map((c) => (<option key={c} value={c}>{c}</option>))}
        </select>
        {(groupFilter || systemFilter || codeFilter || statusFilter || search) && (
          <button className="btn btn-ghost btn-sm"
            onClick={() => { setGroupFilter(''); setSystemFilter(''); setCode(''); setStatus(''); setSearch(''); }}>
            Clear
          </button>
        )}
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)', marginLeft: 'auto' }}>
          {sorted.length} RO{sorted.length === 1 ? '' : 's'}
        </span>
      </div>

      {loading && (
        <div style={{ textAlign: 'center', padding: 40, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted2)' }}>
          Loading…
        </div>
      )}

      <table className="data-table">
        <thead>
          <tr>
            {cols.map(([label, key], i) => (
              <th key={i}
                onClick={() => key && toggleSort(key)}
                style={{ width: cols[i][2] || 'auto',
                  cursor: key ? 'pointer' : 'default',
                  color: key && sortKey === key ? 'var(--accent)' : undefined }}>
                {label}{key ? arrow(key) : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {!loading && sorted.length === 0 && (
            <tr><td colSpan={cols.length} style={{ ...tdBase, textAlign: 'center', color: 'var(--muted2)', padding: 28 }}>
              No repair orders match.
            </td></tr>
          )}
          {sorted.map((ro) => {
            const jobCount = (ro.jobs || []).length;
            const canExpand = jobCount > 1;
            const isOpen = !!expanded[ro.id];
            return (
              <React.Fragment key={ro.id || ro.ro_number}>
                <tr style={{ borderBottom: 'none' }}>
                  {/* expand chevron */}
                  <td style={{ ...tdBase, textAlign: 'center', color: 'var(--muted2)',
                    cursor: canExpand ? 'pointer' : 'default' }}
                    onClick={() => canExpand && setExpanded((p) => ({ ...p, [ro.id]: !p[ro.id] }))}>
                    {canExpand ? (isOpen ? '▾' : '▸') : ''}
                  </td>
                  <td style={{ ...tdBase, fontWeight: 600 }}>
                    {ro.ro_number || ro.vendor_ro_number || '—'}
                  </td>
                  <td style={tdBase}>
                    <span className={`badge ${ro._ro_type === 'vendor' ? 'badge-purple' : ro._ro_type === 'outside' ? 'badge-amber' : 'badge-blue'}`}>
                      {ro._ro_type === 'vendor' ? '🚨 Vendor' : ro._ro_type === 'outside' ? '🔧 Outside' : '🏠 Inside'}
                    </span>
                    {ro._ro_type === 'outside' && ro.vendor_name && (
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted2)', marginTop: 2 }}>{ro.vendor_name}</div>
                    )}
                    {ro._ro_type === 'vendor' && ro.opened_by_name && (
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted2)', marginTop: 2 }}>{ro.opened_by_name}</div>
                    )}
                  </td>
                  <td style={{ ...tdBase, fontSize: 11, color: 'var(--muted2)' }}>{fmtDate(ro.opened_date)}</td>
                  <td style={{ ...tdBase, fontSize: 11, color: ro.reviewed_date ? 'var(--text)' : 'var(--muted2)' }}>
                    {ro.reviewed_date ? fmtDate(ro.reviewed_date) : '—'}
                  </td>
                  <td style={{ ...tdBase, fontSize: 11 }}>{jobCount}</td>
                  <td style={{ ...tdBase, fontSize: 11 }}>{(ro.total_hours || 0).toFixed(1)}h</td>
                  <td style={tdBase}>
                    <span className={`badge ${ro.status === 'reviewed' ? 'badge-green' : ro.status === 'finished' ? 'badge-amber' : ro.status === 'inprogress' ? 'badge-blue' : 'badge-gray'}`}>
                      {ro.status === 'open' ? 'Not Started' : ro.status}
                    </span>
                  </td>
                  <td style={tdBase}>
                    {ro._ro_type === 'inside' ? (
                      <button className="btn btn-sm" onClick={() => onOpenRO(ro)}
                        style={{ background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)',
                          borderRadius: 'var(--radius-sm)', fontWeight: 600, padding: '6px 14px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                        Open →
                      </button>
                    ) : (
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted2)' }}>
                        {ro._ro_type === 'vendor' ? 'Vendor RO' : 'Outside RO'}
                      </span>
                    )}
                  </td>
                </tr>

                {/* Expanded job list */}
                {isOpen && canExpand && (
                  <tr>
                    <td style={{ background: 'var(--page-bg)', borderBottom: '1px solid var(--border2)' }}></td>
                    <td colSpan={cols.length - 1} style={{ padding: '6px 14px 12px', background: 'var(--page-bg)', borderBottom: '1px solid var(--border2)' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr>
                            {['#', 'Code', 'System', 'Group', 'Job / Complaint'].map((h) => (
                              <th key={h} style={{ textAlign: 'left', fontFamily: 'var(--mono)', fontSize: 9,
                                color: 'var(--muted2)', fontWeight: 600, textTransform: 'uppercase',
                                letterSpacing: '.05em', padding: '4px 8px' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {(ro.jobs || []).slice().sort((a, b) => (a.job_number || 0) - (b.job_number || 0)).map((j) => (
                            <tr key={j.id} style={{ borderTop: '1px solid var(--border)' }}>
                              <td style={{ fontFamily: 'var(--mono)', fontSize: 11, padding: '5px 8px', color: 'var(--muted2)' }}>{j.job_number}</td>
                              <td style={{ fontFamily: 'var(--mono)', fontSize: 11, padding: '5px 8px', fontWeight: 600 }}>{j.component_code || '—'}</td>
                              <td style={{ fontFamily: 'var(--mono)', fontSize: 11, padding: '5px 8px' }}>
                                {j._system_code ? `${j._system_code} — ${j._system_name || ''}` : '—'}
                              </td>
                              <td style={{ fontFamily: 'var(--mono)', fontSize: 11, padding: '5px 8px', color: 'var(--muted2)' }}>
                                {j._group_code ? `${j._group_code} — ${j._group_name || ''}` : '—'}
                              </td>
                              <td style={{ fontFamily: 'var(--mono)', fontSize: 11, padding: '5px 8px' }}>
                                {(j.complaint || '').replace(/^Reported issue:\s*/i, '') || '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── ACCESSORIES TAB ───────────────────────────────────────────
function AccessoriesTab({ unit, user }) {
  const [accessories, setAccessories] = useState([]);
  const [master, setMaster] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const isSuperAdmin = user?.role === 'superadmin';

  const load = useCallback(async () => {
    const [accRes, masterRes] = await Promise.all([
      sb
        .from('unit_accessories')
        .select('*')
        .eq('unit_id', unit.id)
        .order('name'),
      sb.from('accessory_master').select('*').order('sort_order'),
    ]);
    setAccessories(accRes.data || []);
    setMaster(masterRes.data || []);
    setLoading(false);
  }, [unit.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleAccessory(name, currentEquipped, existingId) {
    setSaving(true);
    if (existingId) {
      await sb
        .from('unit_accessories')
        .update({ equipped: !currentEquipped })
        .eq('id', existingId);
    } else {
      await sb
        .from('unit_accessories')
        .insert({ unit_id: unit.id, name, equipped: true });
    }
    await load();
    setSaving(false);
  }

  async function addCustom() {
    const name = window.prompt('Accessory name:');
    if (!name) return;
    await sb
      .from('unit_accessories')
      .insert({ unit_id: unit.id, name, equipped: true });
    load();
  }

  function exportCSV() {
    const rows = [
      ['Accessory', 'Equipped'],
      ...master.map((m) => {
        const acc = accessories.find((a) => a.name === m.name);
        return [m.name, acc?.equipped ? 'Yes' : 'No'];
      }),
    ];
    const csv = rows.map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `accessories_${unit.unit_number}.csv`;
    a.click();
  }

  function exportPDF() {
    const win = window.open('', '_blank');
    const rows = master
      .map((m) => {
        const acc = accessories.find((a) => a.name === m.name);
        return `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${
          m.name
        }</td><td style="padding:6px 12px;border-bottom:1px solid #eee;font-weight:600;color:${
          acc?.equipped ? '#15803d' : '#dc2626'
        }">${acc?.equipped ? 'Yes' : 'No'}</td></tr>`;
      })
      .join('');
    win.document.write(
      `<html><head><title>Accessories — Unit #${
        unit.unit_number
      }</title><style>body{font-family:monospace;padding:24px}table{width:100%;border-collapse:collapse}th{text-align:left;padding:8px 12px;background:#f5f5f5;border-bottom:2px solid #ddd}</style></head><body><h2>Unit #${
        unit.unit_number
      } — Accessories</h2><p>${[unit.year, unit.make, unit.model]
        .filter(Boolean)
        .join(' ')} · VIN: ${
        unit.vin || '—'
      }</p><table><thead><tr><th>Accessory</th><th>Equipped</th></tr></thead><tbody>${rows}</tbody></table></body></html>`
    );
    win.document.close();
    win.print();
  }

  return (
    <div style={{ padding: 16 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 14,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--muted2)',
            flex: 1,
          }}
        >
          {accessories.filter((a) => a.equipped).length} equipped
        </span>
        <button className="btn btn-sm" onClick={exportCSV}>
          ↓ CSV
        </button>
        <button className="btn btn-sm" onClick={exportPDF}>
          ↓ Print/PDF
        </button>
        <button className="btn btn-sm btn-primary" onClick={addCustom}>
          + Custom
        </button>
      </div>
      {loading ? (
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 12,
            color: 'var(--muted2)',
          }}
        >
          Loading…
        </div>
      ) : (
        <div
          style={{
            background: 'var(--white)',
            borderRadius: 8,
            border: '1px solid var(--border)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto',
              padding: '8px 14px',
              background: 'var(--page-bg)',
              borderBottom: '1px solid var(--border)',
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
              Accessory
            </span>
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                color: 'var(--muted2)',
                textTransform: 'uppercase',
                letterSpacing: '.08em',
                width: 80,
                textAlign: 'center',
              }}
            >
              Equipped
            </span>
          </div>
          {master.map((m) => {
            const acc = accessories.find((a) => a.name === m.name);
            return (
              <div
                key={m.name}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  padding: '10px 14px',
                  borderBottom: '1px solid var(--border)',
                  alignItems: 'center',
                }}
              >
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                  {m.name}
                </span>
                <div
                  style={{
                    width: 80,
                    display: 'flex',
                    justifyContent: 'center',
                  }}
                >
                  <button
                    onClick={() =>
                      toggleAccessory(m.name, acc?.equipped, acc?.id)
                    }
                    disabled={saving}
                    style={{
                      background: acc?.equipped
                        ? 'var(--green-dim)'
                        : 'var(--red-dim)',
                      border: `1px solid ${
                        acc?.equipped
                          ? 'rgba(21,128,61,.2)'
                          : 'rgba(142,0,0,.2)'
                      }`,
                      borderRadius: 6,
                      padding: '4px 14px',
                      fontFamily: 'var(--mono)',
                      fontSize: 11,
                      fontWeight: 500,
                      color: acc?.equipped ? 'var(--green)' : 'var(--accent)',
                      cursor: 'pointer',
                      transition: 'all .15s',
                      minWidth: 48,
                    }}
                  >
                    {acc?.equipped ? 'Yes' : 'No'}
                  </button>
                </div>
              </div>
            );
          })}
          {/* Custom accessories not in master */}
          {accessories
            .filter((a) => !master.find((m) => m.name === a.name))
            .map((a) => (
              <div
                key={a.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  padding: '10px 14px',
                  borderBottom: '1px solid var(--border)',
                  alignItems: 'center',
                }}
              >
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                  {a.name}{' '}
                  <span style={{ fontSize: 9, color: 'var(--muted2)' }}>
                    custom
                  </span>
                </span>
                <div
                  style={{
                    width: 80,
                    display: 'flex',
                    justifyContent: 'center',
                  }}
                >
                  <button
                    onClick={() => toggleAccessory(a.name, a.equipped, a.id)}
                    disabled={saving}
                    style={{
                      background: a.equipped
                        ? 'var(--green-dim)'
                        : 'var(--red-dim)',
                      border: `1px solid ${
                        a.equipped ? 'rgba(21,128,61,.2)' : 'rgba(142,0,0,.2)'
                      }`,
                      borderRadius: 6,
                      padding: '4px 14px',
                      fontFamily: 'var(--mono)',
                      fontSize: 11,
                      fontWeight: 500,
                      color: a.equipped ? 'var(--green)' : 'var(--accent)',
                      cursor: 'pointer',
                      minWidth: 48,
                    }}
                  >
                    {a.equipped ? 'Yes' : 'No'}
                  </button>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

// ── DOCUMENTS TAB ─────────────────────────────────────────────
function DocumentsTab({ unit, user }) {
  const [docs, setDocs] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    doc_type: 'state_inspection',
    doc_name: '',
    expiration_date: '',
    issued_date: '',
  });
  const fileRef = useRef(null);

  const load = useCallback(() => {
    sb.from('unit_documents')
      .select('*')
      .eq('unit_id', unit.id)
      .order('created_at', { ascending: false })
      .then(({ data }) => setDocs(data || []));
  }, [unit.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function upload() {
    const file = fileRef.current?.files[0];
    if (!file || !form.doc_name) return;
    setUploading(true);
    try {
      // Compress if image
      const processedFile = await compressImage(file);
      const path = `unit-documents/${unit.id}/${Date.now()}_${
        processedFile.name
      }`;
      const { error: upErr } = await sb.storage
        .from('unit-documents')
        .upload(path, processedFile);
      if (upErr) throw upErr;
      await sb.from('unit_documents').insert({
        unit_id: unit.id,
        doc_type: form.doc_type,
        doc_name: form.doc_name,
        storage_path: path,
        file_size_kb: Math.round(processedFile.size / 1024),
        expiration_date: form.expiration_date || null,
        issued_date: form.issued_date || null,
        uploaded_by: user.id,
        uploaded_by_name: user.name || user.email,
      });
      setShowAdd(false);
      setForm({
        doc_type: 'state_inspection',
        doc_name: '',
        expiration_date: '',
        issued_date: '',
      });
      load();
    } catch (err) {
      alert('Upload failed: ' + err.message);
    } finally {
      setUploading(false);
    }
  }

  async function openDoc(doc) {
    const { data } = await sb.storage
      .from('unit-documents')
      .createSignedUrl(doc.storage_path, 300);
    if (data?.signedUrl) window.open(data.signedUrl, '_blank');
  }

  const DOC_TYPES = [
    'state_inspection',
    'carb_cert',
    'title',
    'registration',
    'insurance',
    'other',
  ];

  return (
    <div style={{ padding: 16 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 14,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--muted2)',
            flex: 1,
          }}
        >
          {docs.length} document{docs.length !== 1 ? 's' : ''}
        </span>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setShowAdd(!showAdd)}
        >
          + Upload
        </button>
      </div>

      {showAdd && (
        <div
          style={{
            background: 'var(--white)',
            borderRadius: 8,
            border: '1px solid var(--border)',
            padding: 16,
            marginBottom: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}
          >
            <div className="form-group">
              <div className="form-label">Document Type</div>
              <select
                className="select"
                value={form.doc_type}
                onChange={(e) =>
                  setForm((p) => ({ ...p, doc_type: e.target.value }))
                }
                style={{ width: '100%' }}
              >
                {DOC_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <div className="form-label">Document Name *</div>
              <input
                className="input"
                value={form.doc_name}
                onChange={(e) =>
                  setForm((p) => ({ ...p, doc_name: e.target.value }))
                }
                placeholder="e.g. TX State Inspection 2026"
              />
            </div>
            <div className="form-group">
              <div className="form-label">Issued Date</div>
              <input
                className="input"
                type="date"
                value={form.issued_date}
                onChange={(e) =>
                  setForm((p) => ({ ...p, issued_date: e.target.value }))
                }
              />
            </div>
            <div className="form-group">
              <div className="form-label">Expiration Date</div>
              <input
                className="input"
                type="date"
                value={form.expiration_date}
                onChange={(e) =>
                  setForm((p) => ({ ...p, expiration_date: e.target.value }))
                }
              />
            </div>
          </div>
          <div className="form-group">
            <div className="form-label">
              File (images compressed automatically)
            </div>
            <input
              type="file"
              ref={fileRef}
              accept=".pdf,.jpg,.jpeg,.png,.webp"
              style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setShowAdd(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={upload}
              disabled={uploading || !form.doc_name}
            >
              {uploading ? 'Uploading…' : 'Upload'}
            </button>
          </div>
        </div>
      )}

      <div
        style={{
          background: 'var(--white)',
          borderRadius: 8,
          border: '1px solid var(--border)',
          overflow: 'hidden',
        }}
      >
        {!docs.length && (
          <div
            style={{
              padding: '16px 14px',
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--muted2)',
            }}
          >
            No documents uploaded
          </div>
        )}
        {docs.map((doc) => {
          const isExpired =
            doc.expiration_date && new Date(doc.expiration_date) < new Date();
          const expiringSoon =
            doc.expiration_date &&
            daysUntil(doc.expiration_date) <= 30 &&
            !isExpired;
          return (
            <div
              key={doc.id}
              style={{
                padding: '10px 14px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <span style={{ fontSize: 18 }}>📄</span>
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 12,
                    fontWeight: 500,
                  }}
                >
                  {doc.doc_name}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    color: 'var(--muted2)',
                    marginTop: 2,
                  }}
                >
                  {doc.doc_type.replace(/_/g, ' ')} ·{' '}
                  {doc.file_size_kb ? doc.file_size_kb + 'KB' : ''} ·{' '}
                  {fmtDate(doc.issued_date)} · by {doc.uploaded_by_name}
                </div>
              </div>
              {doc.expiration_date && (
                <div style={{ textAlign: 'right' }}>
                  <div
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 10,
                      color: 'var(--muted2)',
                    }}
                  >
                    Expires
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 11,
                      color: isExpired
                        ? 'var(--accent)'
                        : expiringSoon
                        ? 'var(--amber)'
                        : 'var(--green)',
                      fontWeight: 500,
                    }}
                  >
                    {fmtDate(doc.expiration_date)}
                    {isExpired && ' ⚠ EXPIRED'}
                    {expiringSoon && ` (${daysUntil(doc.expiration_date)}d)`}
                  </div>
                </div>
              )}
              {doc.storage_path && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => openDoc(doc)}
                >
                  View
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── WARRANTY TAB ──────────────────────────────────────────────
// ── SPEND TAB ────────────────────────────────────
// Maintenance spend per unit: YTD + lifetime + $/mile + lemon flag.
// Spend = parts (job_parts.total_cost) + labor (ro_jobs.total_hours x location labor_rate)
//         + outside (outside_ros / vendor_ro_headers). Matches the platform cost model.
function SpendTab({ unit, user }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [fleetAvgPerMile, setFleetAvgPerMile] = useState(null);
  const money = (n) => (n == null || isNaN(n)) ? '—' : '$' + Math.round(Number(n)).toLocaleString();

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        // labor rate for this unit's location (fallback 85)
        let rate = 85;
        if (unit?.location_id) {
          const { data: loc } = await sb.from('locations').select('labor_rate').eq('id', unit.location_id).maybeSingle();
          if (loc && loc.labor_rate != null) rate = Number(loc.labor_rate);
        }
        const ytdStart = new Date().getFullYear() + '-01-01';

        // inside ROs for this unit (parts via job_parts, labor via ro_jobs hours)
        const { data: heads } = await sb.from('ro_headers').select('id,opened_date')
          .eq('unit_number', unit.unit_number).range(0, 49999);
        const roIds = (heads || []).map(h => h.id);
        const dateById = {}; (heads || []).forEach(h => { dateById[h.id] = h.opened_date; });

        let jobs = [];
        if (roIds.length) {
          for (let i = 0; i < roIds.length; i += 300) {
            const chunk = roIds.slice(i, i + 300);
            const { data: jr } = await sb.from('ro_jobs').select('id,ro_id,total_hours').in('ro_id', chunk).range(0, 49999);
            jobs = jobs.concat(jr || []);
          }
        }
        const jobIds = jobs.map(j => j.id);
        const jobRo = {}; jobs.forEach(j => { jobRo[j.id] = j.ro_id; });
        let parts = [];
        if (jobIds.length) {
          for (let i = 0; i < jobIds.length; i += 300) {
            const chunk = jobIds.slice(i, i + 300);
            const { data: pr } = await sb.from('job_parts').select('job_id,total_cost').in('job_id', chunk).range(0, 49999);
            parts = parts.concat(pr || []);
          }
        }

        // outside repair (outside_ros + vendor_ro_headers)
        const [oRes, vRes] = await Promise.all([
          sb.from('outside_ros').select('final_cost,estimated_cost,date_sent,created_at').eq('unit_number', unit.unit_number),
          sb.from('vendor_ro_headers').select('final_cost,estimated_cost,opened_date').eq('unit_number', unit.unit_number),
        ]);

        if (!alive) return;

        const inYtd = (d) => d && d >= ytdStart;
        let partsLife = 0, partsYtd = 0, laborHrsLife = 0, laborHrsYtd = 0, outLife = 0, outYtd = 0;

        parts.forEach(p => {
          const d = dateById[jobRo[p.job_id]];
          const v = Number(p.total_cost) || 0;
          partsLife += v; if (inYtd(d)) partsYtd += v;
        });
        jobs.forEach(j => {
          const d = dateById[j.ro_id];
          const h = Number(j.total_hours) || 0;
          laborHrsLife += h; if (inYtd(d)) laborHrsYtd += h;
        });
        (oRes.data || []).forEach(o => {
          const d = (o.date_sent || o.created_at || '').slice(0, 10);
          const v = Number(o.final_cost ?? o.estimated_cost) || 0;
          outLife += v; if (inYtd(d)) outYtd += v;
        });
        (vRes.data || []).forEach(o => {
          const d = (o.opened_date || '').slice(0, 10);
          const v = Number(o.final_cost ?? o.estimated_cost) || 0;
          outLife += v; if (inYtd(d)) outYtd += v;
        });

        const laborLife = laborHrsLife * rate, laborYtd = laborHrsYtd * rate;
        const lifetime = partsLife + laborLife + outLife;
        const ytd = partsYtd + laborYtd + outYtd;
        const miles = Number(unit.mileage) || 0;
        const perMile = miles > 0 ? lifetime / miles : null;

        setData({
          ytd, lifetime, miles, perMile, rate,
          partsLife, laborLife, outLife, laborHrsLife,
          isTrailer: unit.unit_type === 'trailer',
        });
      } catch (e) { console.error('SpendTab', e); if (alive) setData(null); }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [unit?.unit_number, unit?.location_id, unit?.mileage]);

  // fleet average $/mile for the lemon comparison (trucks only)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await sb.rpc('unit_fleet_cost_per_mile', { p_company: user?.company_id ?? null });
        if (alive && data != null) setFleetAvgPerMile(Number(data));
      } catch { /* RPC optional; lemon flag just hides if unavailable */ }
    })();
    return () => { alive = false; };
  }, [user?.company_id]);

  if (loading) return <div style={{ padding: 24, color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 13 }}>Loading spend…</div>;
  if (!data) return <div style={{ padding: 24, color: 'var(--muted)' }}>No spend data available.</div>;

  const lemon = (!data.isTrailer && data.perMile != null && fleetAvgPerMile != null && fleetAvgPerMile > 0 && data.perMile > fleetAvgPerMile * 1.5);
  const card = { background: 'var(--card-bg,#fff)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px', boxShadow: 'var(--shadow-sm)' };
  const lbl = { fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: '.04em', marginBottom: 6 };
  const big = { fontSize: 26, fontWeight: 700 };

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
        <div style={card}><div style={lbl}>YTD SPEND</div><div style={big}>{money(data.ytd)}</div></div>
        <div style={card}><div style={lbl}>LIFETIME SPEND</div><div style={big}>{money(data.lifetime)}</div><div style={{ fontSize: 11, color: 'var(--muted2)', marginTop: 3 }}>since records began</div></div>
        <div style={card}><div style={lbl}>CURRENT MILES</div><div style={big}>{data.isTrailer ? '—' : (data.miles ? data.miles.toLocaleString() : '—')}</div>{data.isTrailer && <div style={{ fontSize: 11, color: 'var(--muted2)', marginTop: 3 }}>trailer</div>}</div>
        <div style={card}><div style={lbl}>$ / MILE</div><div style={big}>{data.perMile == null ? '—' : '$' + data.perMile.toFixed(2)}</div>{fleetAvgPerMile != null && <div style={{ fontSize: 11, color: 'var(--muted2)', marginTop: 3 }}>fleet avg ${fleetAvgPerMile.toFixed(2)}</div>}</div>
      </div>

      {lemon && (
        <div style={{ background: 'var(--amber-dim,rgba(217,119,6,0.08))', border: '1px solid var(--amber,#92400e)', borderRadius: 8, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16 }}>⚠</span>
          <span style={{ fontSize: 13, color: 'var(--amber,#92400e)' }}>High spend-per-mile vs. fleet average (${fleetAvgPerMile.toFixed(2)}) — review this unit for chronic issues or driver handling.</span>
        </div>
      )}

      <div style={card}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, letterSpacing: '.06em', marginBottom: 12 }}>LIFETIME SPEND BREAKDOWN</div>
        {[['Parts', data.partsLife], ['Labor (' + Math.round(data.laborHrsLife) + ' hrs × $' + data.rate + ')', data.laborLife], ['Outside repair', data.outLife]].map(([l, v]) => (
          <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderTop: '1px solid var(--border)', fontSize: 13 }}>
            <span style={{ color: 'var(--muted)' }}>{l}</span>
            <span style={{ fontFamily: 'var(--mono)' }}>{money(v)}</span>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0 0', borderTop: '2px solid var(--border2)', marginTop: 4, fontSize: 14, fontWeight: 700 }}>
          <span>Total</span><span style={{ fontFamily: 'var(--mono)' }}>{money(data.lifetime)}</span>
        </div>
      </div>
    </div>
  );
}

function WarrantyTab({ unit, user }) {
  const [claims, setClaims] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    claim_number: '',
    date_filed: '',
    vendor: '',
    component_code: '',
    description: '',
    status: 'pending',
    amount_claimed: '',
    amount_recovered: '',
    rejection_reason: '',
  });
  const [saving, setSaving] = useState(false);
  const isSM = ['manager', 'admin', 'superadmin'].includes(user?.role);

  const load = useCallback(() => {
    sb.from('warranty_claims')
      .select('*')
      .eq('unit_id', unit.id)
      .order('date_filed', { ascending: false })
      .then(({ data }) => setClaims(data || []));
  }, [unit.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    setSaving(true);
    try {
      await sb
        .from('warranty_claims')
        .insert({
          ...form,
          unit_id: unit.id,
          created_by: user.id,
          amount_claimed: parseFloat(form.amount_claimed) || null,
          amount_recovered: parseFloat(form.amount_recovered) || null,
        });
      setShowAdd(false);
      load();
    } finally {
      setSaving(false);
    }
  }

  const STATUS_COLORS = {
    pending: 'badge-gray',
    approved: 'badge-blue',
    rejected: 'badge-red',
    paid: 'badge-green',
  };

  return (
    <div style={{ padding: 16 }}>
      <div
        style={{
          display: 'flex',
          gap: 8,
          marginBottom: 14,
          alignItems: 'center',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--muted2)',
            flex: 1,
          }}
        >
          {claims.length} claim{claims.length !== 1 ? 's' : ''}
        </span>
        {isSM && (
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setShowAdd(!showAdd)}
          >
            + New Claim
          </button>
        )}
      </div>

      {showAdd && (
        <div
          style={{
            background: 'var(--white)',
            borderRadius: 8,
            border: '1px solid var(--border)',
            padding: 16,
            marginBottom: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}
          >
            {[
              ['Claim Number', 'claim_number', 'text'],
              ['Date Filed', 'date_filed', 'date'],
              ['Vendor', 'vendor', 'text'],
              ['Component Code', 'component_code', 'text'],
              ['Amount Claimed ($)', 'amount_claimed', 'number'],
              ['Amount Recovered ($)', 'amount_recovered', 'number'],
            ].map(([l, k, t]) => (
              <div key={k} className="form-group">
                <div className="form-label">{l}</div>
                <input
                  className="input"
                  type={t}
                  value={form[k]}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, [k]: e.target.value }))
                  }
                />
              </div>
            ))}
            <div className="form-group">
              <div className="form-label">Status</div>
              <select
                className="select"
                value={form.status}
                onChange={(e) =>
                  setForm((p) => ({ ...p, status: e.target.value }))
                }
                style={{ width: '100%' }}
              >
                {['pending', 'approved', 'rejected', 'paid'].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group" style={{ gridColumn: '1/-1' }}>
              <div className="form-label">Description</div>
              <textarea
                className="textarea"
                value={form.description}
                onChange={(e) =>
                  setForm((p) => ({ ...p, description: e.target.value }))
                }
                rows={2}
              />
            </div>
            {form.status === 'rejected' && (
              <div className="form-group" style={{ gridColumn: '1/-1' }}>
                <div className="form-label">Rejection Reason</div>
                <input
                  className="input"
                  value={form.rejection_reason}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, rejection_reason: e.target.value }))
                  }
                />
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setShowAdd(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={save}
              disabled={saving || !form.vendor || !form.date_filed}
            >
              {saving ? 'Saving…' : 'Add Claim'}
            </button>
          </div>
        </div>
      )}

      <div
        style={{
          background: 'var(--white)',
          borderRadius: 8,
          border: '1px solid var(--border)',
          overflow: 'hidden',
        }}
      >
        {!claims.length && (
          <div
            style={{
              padding: '16px 14px',
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--muted2)',
            }}
          >
            No warranty claims
          </div>
        )}
        {claims.map((claim) => (
          <div
            key={claim.id}
            style={{
              padding: '12px 14px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
            }}
          >
            <div style={{ flex: 1 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 4,
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 12,
                    fontWeight: 500,
                  }}
                >
                  {claim.claim_number || 'No claim #'}
                </span>
                <span
                  className={`badge ${
                    STATUS_COLORS[claim.status] || 'badge-gray'
                  }`}
                >
                  {claim.status}
                </span>
                {claim.component_code && (
                  <span
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 10,
                      color: 'var(--muted2)',
                    }}
                  >
                    {claim.component_code}
                  </span>
                )}
              </div>
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  color: 'var(--muted2)',
                }}
              >
                {claim.vendor} · Filed {fmtDate(claim.date_filed)}
              </div>
              {claim.description && (
                <div
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 11,
                    color: 'var(--text)',
                    marginTop: 3,
                  }}
                >
                  {claim.description}
                </div>
              )}
              {claim.rejection_reason && (
                <div
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 11,
                    color: 'var(--accent)',
                    marginTop: 3,
                  }}
                >
                  Rejected: {claim.rejection_reason}
                </div>
              )}
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              {claim.amount_claimed && (
                <div
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 11,
                    color: 'var(--muted2)',
                  }}
                >
                  Claimed: ${parseFloat(claim.amount_claimed).toFixed(2)}
                </div>
              )}
              {claim.amount_recovered && (
                <div
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 12,
                    fontWeight: 500,
                    color: 'var(--green)',
                  }}
                >
                  Recovered: ${parseFloat(claim.amount_recovered).toFixed(2)}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── MAIN EXPORT ───────────────────────────────────────────────

// last-2 recent searches, this device only
function getRecents(key) { try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; } }
function pushRecent(key, val) {
  const v = (val || '').trim();
  if (!v) return;
  const list = [v, ...getRecents(key).filter((x) => x.toLowerCase() !== v.toLowerCase())].slice(0, 2);
  localStorage.setItem(key, JSON.stringify(list));
}

export default function UnitTab({ user, locationId, deepUnitId, onDeepConsumed, readOnly = false, onOpenUnit }) {
  const [selectedUnit, setSelectedUnit] = useState(null);

  // deep link from another app: ?unit=<id-or-unit_number> -> open that unit's file directly.
  // Callers may pass the unit UUID (Location Hub historically) OR the unit_number
  // (RO page unit link). Try UUID first when it looks like one, else match unit_number.
  useEffect(() => {
    if (!deepUnitId) return;
    let alive = true;
    (async () => {
      const val = String(deepUnitId);
      const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
      let data = null;
      if (looksLikeUuid) {
        const r = await sb.from('units').select('*').eq('id', val).maybeSingle();
        data = r.data;
      }
      if (!data) {
        // Fall back to unit_number (scoped to the user's company).
        let q = sb.from('units').select('*').eq('unit_number', val);
        if (user?.company_id) q = q.eq('company_id', user.company_id);
        const r = await q.maybeSingle();
        data = r.data;
      }
      if (!alive) return;
      if (data) setSelectedUnit(data);
      if (onDeepConsumed) onDeepConsumed();
    })();
    return () => { alive = false; };
  }, [deepUnitId]);

  if (selectedUnit)
    return (
      <UnitProfile
        unit={selectedUnit}
        onBack={() => setSelectedUnit(null)}
        user={user}
      />
    );
  return <UnitList locationId={locationId} onSelect={setSelectedUnit} user={user} />;
}
