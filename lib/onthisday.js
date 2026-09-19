'use strict';
/**
 * "On this day" -- personal record first, world history as fallback, never
 * a hardcoded placeholder. Ported from legacy's onThisDay() (server.js
 * ~1086-1263, dev branch) -- the fix for the "stuck on 1 August 1971"
 * bug: pulse/lib/rhythm.js's DEFAULT_INSIGHTS.calendar has always been a
 * hardcoded string that nothing ever replaced.
 *
 * Two layers:
 *  1. HIS RECORD: scans scope/dates.tsv (his own chosen recurring dates,
 *     which outrank everything), copilot/decisions.tsv, circle/interactions.tsv,
 *     scope/tasks.tsv (done + started), spark/journal.tsv, learning/progress.tsv,
 *     events.tsv -- anything dated this exact month-day in a strictly
 *     earlier year. Heaviest weight wins; ties go to the OLDER memory.
 *  2. WORLD: only consulted if his own record is silent for today. Reads
 *     the pre-pulled history/onthisday.tsv corpus (see default-schema.js's
 *     comment on why it's excluded from the interval sync) and ranks by
 *     significance + relevance to his own world (Kenya/Africa/governance/
 *     tech tags outrank a generic event) + kind (an event beats a birth
 *     beats a holiday) + recency (last century preferred).
 *
 * Vault is the natural home for this (not pulse, which only owned the
 * DEFAULT_INSIGHTS stub): every source collection here belongs to a
 * different engine in the new fleet (scope/circle/spark/vault itself), and
 * vault already has direct store.read() access to all of them without a
 * cross-engine HTTP hop per collection.
 */

const { tsvUnescapeText } = require('./tsv');

const HIS_TAGS = { kenya: 26, africa: 20, independence: 14, governance: 12,
  quality: 12, technology: 10, science: 8, business: 8 };
const KIND_WEIGHT = { event: 12, death: 4, birth: 3, holiday: 0 };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function onThisDay(readTSV, isoDate = null) {
  const today = isoDate || new Date().toISOString().slice(0, 10);
  const [ty, tm, td] = today.split('-').map(Number);
  const mmdd = today.slice(5);
  const entries = [];

  const matches = (raw) => {
    const d = String(raw || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    if (d.slice(5) !== mmdd) return null;
    const y = Number(d.slice(0, 4));
    if (y >= ty) return null;
    return { date: d, years: ty - y };
  };

  const add = (weight, kind, title, detail, hit, extra = {}) => {
    if (!hit) return;
    entries.push({ weight, kind, title: String(title || '').trim(),
      detail: String(detail || '').trim(), date: hit.date, years: hit.years, ...extra });
  };

  const val = (v) => (v === undefined || v === null || v === '-' ? '' : String(v));
  const safe = (fn) => { try { fn(); } catch { /* a missing/unreadable collection just contributes nothing */ } };

  safe(() => {
    for (const r of readTSV('scope/dates.tsv')) {
      add(100, 'milestone', val(r.TITLE), val(r.NOTE) || val(r.KIND), matches(r.DATE), { who: val(r.WHO), kindLabel: val(r.KIND) });
    }
  });
  safe(() => {
    for (const r of readTSV('copilot/decisions.tsv')) {
      add(80, 'decision', val(r.TITLE) || val(r.DECISION), val(r.STATUS) || val(r.NOTE), matches(r.DATE || r.CREATED_AT || r.DECIDED_AT));
    }
  });
  safe(() => {
    const people = {};
    for (const p of readTSV('circle/people.tsv')) people[val(p.ID)] = val(p.NAME) || val(p.ID);
    for (const r of readTSV('circle/interactions.tsv')) {
      const who = people[val(r.PERSON_ID)] || val(r.PERSON_ID);
      add(70, 'touch', who ? `Spoke with ${who}` : 'A conversation', val(r.SUMMARY), matches(r.DATE), { who, channel: val(r.CHANNEL), personId: val(r.PERSON_ID) });
    }
  });
  safe(() => {
    for (const r of readTSV('scope/tasks.tsv')) {
      add(60, 'done', val(r.TITLE), val(r.RESOLUTION) || 'Finished', matches(r.DONE_AT));
      add(25, 'started', val(r.TITLE), val(r.WHY), matches(r.CREATED_AT));
    }
  });
  safe(() => {
    for (const r of readTSV('spark/journal.tsv')) {
      const body = tsvUnescapeText(val(r.BODY));
      add(45, 'journal', 'Journal entry', body.length > 160 ? `${body.slice(0, 157)}...` : body, matches(r.DATE));
    }
  });
  safe(() => {
    for (const r of readTSV('learning/progress.tsv')) {
      add(35, 'learning', `${val(r.COURSE_ID)} · ${val(r.LESSON)}`, `Marked ${val(r.STATUS)}`, matches(r.UPDATED_AT));
    }
  });
  safe(() => {
    for (const r of readTSV('events.tsv')) {
      let msg = '';
      try { msg = String(JSON.parse(val(r.PAYLOAD) || '{}').message || ''); } catch {}
      add(15, 'event', val(r.TYPE), msg, matches(r.CREATED_AT), { source: val(r.SOURCE) });
    }
  });

  entries.sort((a, b) => b.weight - a.weight || b.years - a.years);

  const monthName = MONTHS[tm - 1];
  const plural = (n) => `${n} year${n === 1 ? '' : 's'} ago`;

  let world = [];
  safe(() => {
    for (const r of readTSV('history/onthisday.tsv')) {
      if (val(r.MMDD) !== mmdd) continue;
      const tags = val(r.TAGS).split(',').map(t => t.trim()).filter(Boolean);
      const year = Number(val(r.YEAR)) || 0;
      const score = (Number(val(r.SIGNIFICANCE)) || 0) / 2
        + tags.reduce((a, t) => a + (HIS_TAGS[t] || 0), 0)
        + (KIND_WEIGHT[val(r.KIND)] ?? 0)
        + (year >= 1925 ? 6 : 0);
      world.push({ score, year, kind: val(r.KIND), tags, event: val(r.EVENT), detail: val(r.DETAIL),
        years: year && year < ty ? ty - year : null });
    }
  });
  world.sort((a, b) => b.score - a.score || (a.year - b.year));

  let card = null;
  if (entries.length) {
    const top = entries[0];
    const rest = entries.length - 1;
    card = {
      title: 'On this day', category: `${monthName} ${td} · your record`,
      event: `${plural(top.years)}: ${top.title}`,
      explain: top.detail || (top.kind === 'done' ? 'You finished this on this date.' : 'From your own record.'),
      text: `${plural(top.years)}: ${top.title}${top.detail ? ` - ${top.detail}` : ''}`,
      tone: 'gold', source: 'own',
      more: rest > 0 ? `and ${rest} more thing${rest === 1 ? '' : 's'} on this date` : '',
      top, count: entries.length,
    };
  } else if (world.length) {
    const w = world[0];
    card = {
      title: 'On this day', category: `${monthName} ${td}${w.year ? ` · ${w.year}` : ''}`,
      event: w.event,
      explain: w.detail && w.detail !== '-' ? w.detail : `${w.years ? `${plural(w.years)}.` : ''} Nothing of yours is recorded on this date yet.`,
      text: w.event, tone: 'gold', source: 'world',
      more: world.length > 1 ? `${world.length - 1} more from this date in the vault` : '',
      top: null, count: entries.length, tags: w.tags, year: w.year,
    };
  }

  return { date: today, entries: entries.slice(0, 40), world: world.slice(0, 12), card };
}

module.exports = { onThisDay };
