// Shop Command — AI PM forecast.
// Predicts likely service needs across a location's overdue + coming-due units.
// The Anthropic key lives ONLY in ANTHROPIC_API_KEY (server-side). Every real run
// is logged to ai_usage_log (feature 'predict_pm', with location_id) for the HQ
// Analytics Hub AI Usage Tracker.
//
// The app POSTs { company_id, location_id, units, fingerprint, meta }.
//   units: [{ unit_number, unit_type, year, make, model, engine_model, status,
//             current_miles, days_overdue, days_to_due, components:[{code,name,
//             last_done_miles, miles_since, times_done, derived_interval}] }]
//   fingerprint: client-computed data-state hash for free-refresh detection.
//
// Refresh gate (server-enforced, in order):
//   1) DAILY LOCK  — if a real run already happened today for this location -> reuse.
//   2) FINGERPRINT — if data unchanged since last run -> reuse (no AI, no count).
//   3) WEEKLY CAP  — max 3 real runs / location / week (resets Sunday) -> at-limit msg.
//   else -> call Claude, save to pm_ai_forecasts, log usage.

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const WEEKLY_CAP = 3;

const SB_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://jvtbogrwutcmurvzymcw.supabase.co';
const SB_KEY = process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_KEY || 'sb_publishable_O8wL7rVpMA0Rkh86wQumDw_6bHG-kGS';

const sbHeaders = { 'content-type': 'application/json', 'apikey': SB_KEY, 'authorization': `Bearer ${SB_KEY}` };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

async function sbGet(path) {
  try { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders }); return r.ok ? await r.json() : null; }
  catch { return null; }
}
async function sbUpsertForecast(row) {
  try {
    await fetch(`${SB_URL}/rest/v1/pm_ai_forecasts?on_conflict=company_id,location_id`, {
      method: 'POST',
      headers: { ...sbHeaders, 'prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });
  } catch { /* non-fatal */ }
}
async function logUsage(row) {
  try {
    await fetch(`${SB_URL}/rest/v1/ai_usage_log`, {
      method: 'POST', headers: { ...sbHeaders, 'prefer': 'return=minimal' }, body: JSON.stringify(row),
    });
  } catch { /* logging must never break the request */ }
}

// Start of the current week = most recent Sunday 00:00 UTC.
function weekStartISO() {
  const d = new Date();
  const day = d.getUTCDay(); // 0 = Sunday
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}
function isSameUTCDate(aIso, b) {
  const a = new Date(aIso);
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

const QUIRKY_LIMIT = "Whoa there — the crystal ball needs a breather. You get 3 fresh forecasts per location each week so the predictions stay sharp, and you've used all 3. I'll keep gathering unit details in the meantime — check back Sunday with fresh eyes. (Your last forecast is still shown below.)";

const SYSTEM = `You are the PM Forecast engine inside a fleet-maintenance platform for a commercial trucking fleet. You help a Terminal Manager or maintenance planner decide what each overdue or coming-due truck is LIKELY to need at its next preventive-maintenance visit, so they can plan outside-vendor work and budget.

You are given a JSON list of units. For EACH unit you get its current odometer, how overdue / how soon due it is, and a per-component service history: each component's last-service mileage, miles since then, how many times it's been done, and a typical interval. The interval is either "derived" (computed from THIS unit's own history — trust it more) or "standard" (an industry default used because the unit lacks history — hedge confidence lower).

Hard rules:
- Use ONLY the data provided. Never invent a mileage, a cost, or a component that isn't in the unit's data. If a unit has no service history, say predictions are based on standard intervals and keep confidence LOW.
- For each unit, predict the components MOST likely due at the next PM. A component is "likely due" when miles_since is at or beyond its interval; "watch" when it's approaching (within ~20%). Don't list components that were just done.
- Confidence: HIGH only when a derived interval and the miles strongly agree; MED for approaching or standard-interval calls; LOW for thin/no history.
- Give a rough cost band only if it's obviously implied by the component type at a coarse level (e.g. tires are a larger spend than an air filter) — keep it qualitative, do not fabricate dollar figures.
- If a unit's data shows it is a high spend-per-mile unit (flagged), add a short note that a longer vendor slot may be wise (likely multi-item visit).
- PMs themselves are routine; only call out the corrective items likely to surface.

Output STRICT JSON, no prose, no markdown fences. Shape:
{"units":[{"unit_number":"...","headline":"one short line summary","items":[{"label":"Tires","detail":"~7.7k mi since last","confidence":"high","severity":"due"},{"label":"Brakes","detail":"approaching interval","confidence":"med","severity":"watch"}],"note":"optional one-liner or empty string"}]}
severity is one of: "due","watch","routine". Keep labels 1-3 words, details under 8 words. Return units in the same order given.`;

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ error: 'not_configured' });

  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const company_id = body.company_id || null;
  const location_id = body.location_id || null;
  const units = Array.isArray(body.units) ? body.units : [];
  const fingerprint = String(body.fingerprint || '');
  const meta = body.meta || {};
  const force = !!body.force; // reserved; gate still applies
  if (!company_id || !location_id) return json({ error: 'bad_request', detail: 'company_id and location_id required' }, 400);
  if (!units.length) return json({ error: 'no_units', detail: 'No overdue or coming-due units to forecast.' });

  // ── load the existing forecast for this location ──
  const existing = await sbGet(`pm_ai_forecasts?company_id=eq.${company_id}&location_id=eq.${encodeURIComponent(location_id)}&select=*&limit=1`);
  const prev = existing && existing[0] ? existing[0] : null;
  const now = new Date();

  // GATE 1 — daily lock: a real run already happened today for this location.
  if (prev && prev.ran_at && isSameUTCDate(prev.ran_at, now)) {
    return json({ status: 'reused_daily', reason: 'already_ran_today', forecast: prev.forecast, ran_at: prev.ran_at });
  }
  // GATE 2 — fingerprint: nothing changed since last run -> free re-show.
  if (prev && prev.fingerprint && fingerprint && prev.fingerprint === fingerprint) {
    return json({ status: 'reused_unchanged', reason: 'no_data_change', forecast: prev.forecast, ran_at: prev.ran_at });
  }
  // GATE 3 — weekly cap (per location, resets Sunday). Count real predict_pm runs this week.
  const since = weekStartISO();
  const wk = await sbGet(`ai_usage_log?feature=eq.predict_pm&had_error=eq.false&company_id=eq.${company_id}&location_id=eq.${encodeURIComponent(location_id)}&created_at=gte.${encodeURIComponent(since)}&select=id`);
  const usedThisWeek = Array.isArray(wk) ? wk.length : 0;
  if (usedThisWeek >= WEEKLY_CAP) {
    return json({ status: 'limit_reached', message: QUIRKY_LIMIT, forecast: prev ? prev.forecast : [], ran_at: prev ? prev.ran_at : null, used: usedThisWeek, cap: WEEKLY_CAP });
  }

  // ── run the model (BATCHED) ──────────────────────────────────────────────
  // Output size scales with unit count; a single call truncates at max_tokens for
  // large terminals (this is what produced empty forecasts). Batch the units so the
  // output per call is bounded, then merge. One logical "run" regardless of batches.
  const BATCH_SIZE = 8;
  const MAX_TOKENS = 4096;
  const baseRow = {
    company_id, company_name: meta.company_name || null,
    user_id: meta.user_id || null, user_name: meta.user_name || null, user_role: meta.user_role || null,
    location_id, feature: 'predict_pm', question: `PM forecast: ${units.length} units`, model: MODEL,
  };

  function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

  async function runBatch(batchUnits) {
    const userContent = `Units to forecast (JSON). Use ONLY these numbers.\n\n${JSON.stringify({ units: batchUnits })}`;
    const t0 = Date.now();
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, messages: [{ role: 'user', content: userContent }] }),
    });
    const latency_ms = Date.now() - t0;
    let data = {};
    try { data = await r.json(); } catch { data = {}; }
    if (!r.ok) {
      return { ok: false, units: [], latency_ms, error_type: (data && data.error && data.error.type) || ('http_' + r.status), detail: (data && data.error && data.error.message) || ('HTTP ' + r.status), usage: {} };
    }
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    // strip optional code fences, tolerate a trailing truncation by trying a best-effort parse
    let parsed = null;
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```$/,'').trim();
    try { parsed = JSON.parse(cleaned); }
    catch { parsed = null; }
    const fc = parsed && Array.isArray(parsed.units) ? parsed.units : [];
    const stopReason = data.stop_reason || null;
    return { ok: true, units: fc, latency_ms, usage: data.usage || {}, stop_reason: stopReason };
  }

  try {
    const batches = chunk(units, BATCH_SIZE);
    let forecast = [];
    let totalLatency = 0, totalIn = 0, totalOut = 0;
    let anyBatchError = null;
    let truncated = false;

    for (const b of batches) {
      const res = await runBatch(b);
      totalLatency += res.latency_ms || 0;
      if (!res.ok) { anyBatchError = res; continue; }      // keep other batches
      if (res.stop_reason === 'max_tokens') truncated = true;
      forecast = forecast.concat(res.units || []);
      totalIn += res.usage.input_tokens || 0;
      totalOut += res.usage.output_tokens || 0;
    }

    // Log ONE usage row for the whole run (keeps weekly-cap accounting at 1/run).
    if (forecast.length > 0) {
      await logUsage({ ...baseRow, latency_ms: totalLatency, input_tokens: totalIn || null, output_tokens: totalOut || null, had_error: false });
      await sbUpsertForecast({
        company_id, location_id, forecast, fingerprint,
        unit_count: units.length, ran_at: new Date().toISOString(),
        ran_by: meta.user_id || null, ran_by_name: meta.user_name || null,
      });
      return json({ status: 'fresh', forecast, ran_at: new Date().toISOString(), used: usedThisWeek + 1, cap: WEEKLY_CAP, partial: truncated || !!anyBatchError });
    }

    // Nothing parsed across all batches -> DO NOT save and DO NOT trip the daily lock.
    await logUsage({ ...baseRow, latency_ms: totalLatency, had_error: true, error_type: anyBatchError ? (anyBatchError.error_type || 'api_error') : 'empty_parse' });
    return json({ error: anyBatchError ? 'api_error' : 'empty_parse', detail: anyBatchError ? anyBatchError.detail : 'The model returned no usable forecast. Try again.' });
  } catch (e) {
    await logUsage({ ...baseRow, latency_ms: 0, had_error: true, error_type: 'fetch_failed' });
    return json({ error: 'fetch_failed', detail: String(e) });
  }
};
