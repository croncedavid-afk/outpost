// Shared constants + helpers ported verbatim from Shop Command's App.jsx so the
// ported ROPage and UnitTab behave identically. Keep these in sync with
// shop_command/src/App.jsx if they ever change there.

export const LOC_NUMBERS = {
  houston: '5206',
  dallas: '5201',
  beaumont: '5212',
  diboll: '5213',
  baton_rouge: '2701',
};

// Format: {code}-{seq4}{yy}  e.g. 5212-090026 (Beaumont's 900th RO of 2026).
export function generateRONumber(locationCodeOrId, sequenceNum) {
  const locNum = LOC_NUMBERS[locationCodeOrId] || locationCodeOrId || '0000';
  const year = new Date().getFullYear().toString().slice(-2);
  return `${locNum}-${String(sequenceNum).padStart(4, '0')}${year}`;
}

export const JOB_STATUS = {
  not_started: { label: 'Not Started', color: '#6b7280', badge: 'badge-gray' },
  inprogress: { label: 'In Progress', color: '#1d4ed8', badge: 'badge-blue' },
  waiting: { label: 'Waiting', color: '#92400e', badge: 'badge-amber' },
  finished: { label: 'Finished', color: '#166534', badge: 'badge-green' },
  kicked_back: { label: 'Kicked Back', color: '#8e0000', badge: 'badge-red' },
  denied: { label: 'Denied', color: '#6b7280', badge: 'badge-gray' },
};
