'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DAY, IN BLOCKS - his own time model, made operational
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Architect's split, given 4 Aug and completed to all 24 hours on 5 Aug:
 *
 *   05:00-06:00  PROTECTED    wake, shower, workout, meditate. NO PHONE
 *   06:00-07:00  learning     one hour, before the engagement day
 *   07:00-08:00  flex         commute in, or anything else
 *   08:00-10:00  innovator    systems built, engineered, forecast
 *   10:00-11:00  flex         unallocated - meetings, teammates, ad-hoc
 *   11:00-13:00  leadership   people, decisions, the record
 *   13:00-14:00  lunch        lunch, specifically
 *   14:00-16:00  creative     work made to be seen, read and used
 *   16:00-17:00  CONNECTION   people: teammates, meet-ups, consulting at work;
 *                             calls to friends and family outside it
 *   17:00-18:00  flex         commute home, or anything else
 *   18:00-21:00  home         house work and home life
 *   21:00-05:00  REST         sleep - the one block that wraps midnight
 *
 * Three thirds of eight hours: work, personal, rest. The four named work axes
 * are the only blocks a board task may ever land in.
 *
 * ─── ENGAGEMENT-AGNOSTIC BY CONSTRUCTION ────────────────────────────────────
 *
 * His instruction, 5 Aug: "when I say work, it does not necessarily mean Viva
 * work... this agent has to be agnostic enough to outlive any particular
 * engagement." So no block names an employer, the 08:00-17:00 window is "the
 * engagement" rather than Viva, and changing employer is a change to zero rows
 * in this file. The four work axes describe the KIND of work, which is a fact
 * about him and survives every job.
 *
 * Three of those are the axes his own space tree already declares - AX-INN
 * Innovator, AX-VIS Visionary, AX-CRE Creator - which is why the mapping below is
 * a reading of his system rather than a new taxonomy bolted onto it.
 *
 * ─── WHY THE ALLOCATION IS ARITHMETIC AND NOT A MODEL ───────────────────────
 *
 * A plan he cannot predict is a plan he will not trust, and the second time it
 * puts "Agree the drafting split with Taylor" in the creative block he will stop
 * looking at it. So every point is scored by a rule stated here, and every
 * allocated task carries the reason it landed where it did. He can disagree with
 * a rule; he can never be surprised by one.
 *
 * The signals are the ones his OWN task rows actually carry - measured, not
 * imagined, against 73 open tasks on 4 Aug:
 *
 *   a person from his circle named in the title    46 rows carry ASSIGNED_BY, 38
 *                                                  an ASSIGNEE, and the titles
 *                                                  name Alex, Taylor, Elly by hand
 *   the verb the title opens with                  "Raise", "Agree", "Re-ask" are
 *                                                  coordination; "Source",
 *                                                  "Deliver" are making; "Build",
 *                                                  "Automate" are systems
 *   the tag                                        viva-valentia, competitors,
 *                                                  portals, hero, testing...
 *   the deliverable                                a task with a DELIVERABLE is
 *                                                  something to be produced
 *
 * ─── CAPACITY IS REAL ──────────────────────────────────────────────────────
 *
 * A block is two hours, not infinite. Tasks are budgeted at 30 minutes each
 * because nothing in his ledger carries an estimate, and a made-up estimate is
 * worse than a stated convention. What does not fit is listed as overflow rather
 * than crammed in - the whole value of a block is that it has an edge.
 */

let deps = null;
/** @param d {{ readTSV, appendTSV, rewriteTSV, auditLog }} */
function init(d) {
  if (typeof d?.readTSV !== 'function') throw new Error('lib/blocks: init needs readTSV');
  deps = d;
}

const val = (v) => (v === undefined || v === null || v === '-' ? '' : String(v));
const clean = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
const TASK_MINUTES = 30;

/** "08:00" to 480. Anything unparseable is null, never a guessed zero. */
function toMins(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins >= 0 && mins <= 24 * 60 ? mins : null;
}
const toClock = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
const say = (mins) => (mins >= 60
  ? `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}`
  : `${mins}m`);

/** His blocks, in clock order. Seeded once if the file is empty. */
const SEED = [
  ['BLK-LEARN', 'Learning', '06:00', '07:00', 'learning', 'learn,course,module,study,revise,read,lesson', 'One hour before the day starts'],
  ['BLK-INN', 'Innovator', '08:00', '10:00', 'innovator', 'build,engineer,system,agent,api,script,automate,pipeline,model,forecast,benchmark,analyse,analyze,data,integrate,deploy,fix,debug', 'Systems built, engineered and forecast'],
  ['BLK-LEAD', 'Leadership', '11:00', '13:00', 'visionary', 'raise,ask,agree,offer,confirm,escalate,meet,present,negotiate,decide,approve,review,chase,align,brief,report,respond,reply', 'People, decisions and the record'],
  ['BLK-CRE', 'Creative', '14:00', '16:00', 'creator', 'draft,write,deliver,design,source,compose,produce,publish,catalogue,register,content,copy,image,hero,post,article,document', 'Work made to be seen, read and used'],
];

function blocks() {
  let rows = deps.readTSV('scope/blocks.tsv');
  if (!rows.length) {
    for (const r of SEED) {
      deps.appendTSV('scope/blocks.tsv', {
        ID: r[0], NAME: r[1], START: r[2], END: r[3], AXIS: r[4], MATCH: r[5],
        CAPACITY: '-', ACTIVE: 'yes', NOTE: r[6],
      });
    }
    deps.auditLog?.('blocks_seeded', { rows: SEED.length });
    rows = deps.readTSV('scope/blocks.tsv');
  }
  return rows
    .filter(r => (val(r.ACTIVE) || 'yes') !== 'no')
    .map(r => {
      const start = toMins(val(r.START)), end = toMins(val(r.END));
      // A block whose end is at or before its start crosses midnight - the Rest
      // block runs 21:00 to 05:00. Its length is the way round the clock, not a
      // negative number, and `wraps` is what every consumer branches on.
      const wraps = start !== null && end !== null && end <= start;
      const minutes = start === null || end === null ? 0
        : wraps ? (end + 24 * 60) - start
        : end - start;
      const axis = val(r.AXIS).toLowerCase();
      const declared = Number(val(r.CAPACITY));
      // Only the four working axes ever receive a board task. Morning, Commute,
      // Flex, Home and Rest are the rest of the 24 hours - they exist so the day
      // is fully accounted for, not so work can be poured into them. Declared as
      // an allowlist rather than a denylist: a new personal block added later is
      // non-placeable by default, which is the safe direction to be wrong in.
      /* CONNECTION joined the work axes on 5 Aug. It is deliberately kept
         distinct from Leadership: Leadership is decisions and the record, where
         the output is a ruling; Connection is the relationship itself - a call
         to a teammate, a catch-up, a consult, or family in the evening. Its
         match words avoid "meet", which Leadership already owns, so a real
         coordination task still lands in Leadership rather than being pulled
         into the last hour of the engagement day. */
      const WORK_AXES = new Set(['learning', 'innovator', 'visionary', 'creator', 'connection']);
      const placeable = WORK_AXES.has(axis);
      // PROTECTED and REST are quiet hours: no notification, no reminder, no
      // nudge may fire inside them. 05:00-06:00 is his shower, workout and
      // meditation with the phone down, and he asked for it to be protected
      // always - so it is a property of the data, not a habit of the caller.
      const quiet = axis === 'protected' || axis === 'rest';
      /* Which third of the 8-8-8 this hour belongs to: work | personal | rest.
         It is a COLUMN, not an inference, because the inference is wrong in both
         directions - the 07:00 and 17:00 flex hours are commutes and belong to
         the personal third, while the 13:00 lunch hour sits inside the
         engagement window and also belongs to personal. Declaring it as data is
         what lets him move a block between thirds without a code change, and
         what keeps the model agnostic to which engagement he is in.
         Falls back to a reasonable guess for rows written before the column. */
      const third = (val(r.THIRD) || '').toLowerCase()
        || (axis === 'rest' ? 'rest' : WORK_AXES.has(axis) ? 'work' : 'personal');
      return {
        id: val(r.ID), name: val(r.NAME) || val(r.ID),
        start, end, startClock: val(r.START), endClock: val(r.END),
        axis, note: val(r.NOTE), wraps, placeable, quiet, third,
        match: val(r.MATCH).split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
        minutes,
        slots: !placeable ? 0
          : Number.isFinite(declared) && declared > 0 ? declared
          : Math.max(1, Math.floor(minutes / TASK_MINUTES)),
      };
    })
    .filter(b => b.start !== null && b.end !== null)
    .sort((a, b) => a.start - b.start);
}

/**
 * Where the day is right now: the block he is inside, the one coming, and how
 * much of the whole span has gone. The span is derived from the blocks
 * themselves - if he moves his first block to 05:00 the arc follows, and nothing
 * has a working day hardcoded into it any more.
 */
function now(date = new Date()) {
  const bs = blocks();
  const mins = date.getHours() * 60 + date.getMinutes();
  // The arc is the WAKING day, so the wrapping Rest block is excluded from it -
  // otherwise the last block's end (05:00) lands before the first block's start
  // and the fraction goes negative. Rest can still be the current block.
  const awake = bs.filter(b => !b.wraps);
  const dayStart = awake.length ? awake[0].start : 8 * 60;
  const dayEnd = awake.length ? awake[awake.length - 1].end : 17 * 60;
  const inside = (b) => (b.wraps
    ? (mins >= b.start || mins < b.end)      // 21:00-05:00 contains 23:30 and 04:00
    : (mins >= b.start && mins < b.end));
  const current = bs.find(inside) || null;
  const next = bs.find(b => b.start > mins) || null;
  const gap = awake.length && !current && mins >= dayStart && mins < dayEnd;
  // Minutes left in the current block, the long way round the clock when it wraps.
  const leftIn = (b) => (b.wraps && mins >= b.start ? (b.end + 24 * 60) - mins : b.end - mins);
  // Time until the next block. Past the last start, the next one is tomorrow's first.
  const firstBlock = bs.length ? bs[0] : null;
  const upcoming = next || firstBlock;
  const untilNext = next ? next.start - mins
    : firstBlock ? (firstBlock.start + 24 * 60) - mins : null;

  return {
    at: toClock(mins), mins, dayStart, dayEnd,
    dayStartClock: toClock(dayStart), dayEndClock: toClock(dayEnd),
    fraction: Math.max(0, Math.min(1, (mins - dayStart) / Math.max(1, dayEnd - dayStart))),
    before: mins < dayStart, after: mins >= dayEnd, gap,
    // Callers that push anything at him check this one flag. True inside
    // PROTECTED (05:00-06:00, phone down) and REST (21:00-05:00).
    quiet: Boolean(current && current.quiet),
    current: current && { ...current, leftMins: leftIn(current), left: say(leftIn(current)) },
    next: upcoming && untilNext != null && { ...upcoming, inMins: untilNext, in: say(untilNext) },
    // The one line the surfaces show. Every branch is a fact about the clock.
    line: current ? `${current.name} block · ${say(leftIn(current))} left`
      : mins < dayStart ? `${firstBlock ? firstBlock.name : 'The day'} starts ${say(dayStart - mins)} from now`
      : upcoming && untilNext != null ? `Between blocks · ${upcoming.name} in ${say(untilNext)}`
      : 'Blocks are done for today',
    blocks: bs,
  };
}

/**
 * Which block a task belongs to, and why.
 *
 * Returns every block's score so a surface can show the runner-up if he wants to
 * argue with it. The `why` strings are the audit trail: each one names the signal
 * and what it matched, never "because it seemed to fit".
 */
function classify(task, { people = [], blocks: bs = null } = {}) {
  const list = bs || blocks();
  const title = clean(val(task.TITLE)).toLowerCase();
  const tag = val(task.TAG).toLowerCase();
  const firstWord = (title.split(/\s+/)[0] || '').replace(/[^a-z]/g, '');
  // SAFETY: escape regex metacharacters before constructing RegExp from user data.
  // A phone number or symbol in NAME (e.g. "+254…") would otherwise throw
  // "Invalid regular expression: Nothing to repeat" and crash the vault process —
  // confirmed incident 2026-08-17, causing PIN/auth loss until manual restart.
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = people.filter(p => {
    const n = clean(val(p.NAME)).split(/\s+/)[0];
    if (!n || n.length <= 2) return false;
    try { return new RegExp(`\\b${escapeRegex(n.toLowerCase())}\\b`).test(title); }
    catch { return false; }
  }).map(p => clean(val(p.NAME)).split(/\s+/)[0]);

  const scores = list.map(b => {
    let score = 0;
    const why = [];

    // The verb the title opens with is the strongest single signal, because his
    // titles are written as instructions to himself.
    if (b.match.includes(firstWord)) { score += 34; why.push(`opens with "${firstWord}"`); }

    // Any other match word appearing anywhere, capped so a long title cannot
    // out-vote a clear opening verb.
    const hits = b.match.filter(w => w !== firstWord && new RegExp(`\\b${w}`).test(title));
    if (hits.length) {
      score += Math.min(24, hits.length * 8);
      why.push(`mentions ${hits.slice(0, 3).join(', ')}`);
    }

    // Somebody else is in it: that is coordination, which is the leadership block
    // whatever the verb says.
    if (b.axis === 'visionary') {
      if (named.length) { score += 30; why.push(`names ${named.slice(0, 2).join(' and ')}`); }
      if (val(task.ASSIGNEE)) { score += 14; why.push('someone else is assigned'); }
      if (val(task.ASSIGNED_BY)) { score += 12; why.push(`tabled by ${val(task.ASSIGNED_BY)}`); }
      if (val(task.JIRA_KEY)) { score += 8; why.push('tracked in Jira'); }
    }

    // Something has to come out of it: that is the creative block's definition.
    if (b.axis === 'creator' && val(task.DELIVERABLE)) { score += 18; why.push('has a deliverable'); }

    // The learning space owns its own tasks outright.
    if (b.axis === 'learning' && /\b(learn|course|module|lesson)\b/.test(`${title} ${tag}`)) {
      score += 30; why.push('learning work');
    }

    if (tag && b.match.includes(tag)) { score += 10; why.push(`tagged ${tag}`); }
    return { block: b, score, why };
  }).sort((a, b) => b.score - a.score || a.block.start - b.block.start);

  const top = scores[0];
  // A task nothing matched is UNPLACED, not quietly dropped into the first block.
  return {
    blockId: top && top.score > 0 ? top.block.id : null,
    score: top ? top.score : 0,
    why: top && top.score > 0 ? top.why.join('; ') : 'nothing in the title matched a block',
    runnerUp: scores[1] && scores[1].score > 0 ? { id: scores[1].block.id, score: scores[1].score } : null,
    scores: scores.map(s => ({ id: s.block.id, score: s.score })),
  };
}

/**
 * The day's plan: every open task placed in a block, in the order he should take
 * them, with what did not fit called out.
 *
 * Order inside a block is urgency first and the classifier's confidence last,
 * because the point of the block is WHEN, not HOW SURE:
 *   overdue, then due today, then priority, then score.
 */
function plan({ tasks = [], people = [], date = new Date() } = {}) {
  const bs = blocks();
  const today = date.toISOString().slice(0, 10);
  const open = tasks.filter(t => {
    const s = val(t.STATUS).toLowerCase();
    return s !== 'done' && s !== 'dropped' && s !== 'cancelled';
  });

  const PRIO = { critical: 0, high: 1, medium: 2, low: 3, lowest: 4 };
  const graded = open.map(t => {
    const c = classify(t, { people, blocks: bs });
    const due = val(t.DUE_DATE);
    return {
      id: val(t.ID), title: val(t.TITLE), tag: val(t.TAG),
      priority: val(t.PRIORITY) || 'medium', due, status: val(t.STATUS),
      assignee: val(t.ASSIGNEE), assignedBy: val(t.ASSIGNED_BY),
      overdue: !!due && due < today, dueToday: due === today,
      blockId: c.blockId, score: c.score, why: c.why, runnerUp: c.runnerUp,
    };
  }).sort((a, b) =>
    (a.overdue === b.overdue ? 0 : a.overdue ? -1 : 1)
    || (a.dueToday === b.dueToday ? 0 : a.dueToday ? -1 : 1)
    || ((PRIO[a.priority] ?? 9) - (PRIO[b.priority] ?? 9))
    || (b.score - a.score));

  const placed = new Map(bs.map(b => [b.id, []]));
  const overflow = [];
  const unplaced = [];
  for (const t of graded) {
    if (!t.blockId) { unplaced.push(t); continue; }
    const block = bs.find(b => b.id === t.blockId);
    // A non-placeable block has 0 slots, so anything classified into one
    // overflows rather than silently occupying sleep or the commute.
    const bucket = placed.get(t.blockId);
    const cap = block?.placeable ? (block.slots ?? 0) : 0;
    if (bucket && cap > 0 && bucket.length < cap) bucket.push(t);
    else overflow.push(t);
  }

  const n = now(date);
  return {
    date: today, now: n,
    blocks: bs.map(b => ({
      ...b,
      tasks: placed.get(b.id) || [],
      full: (placed.get(b.id) || []).length >= b.slots,
      current: n.current?.id === b.id,
      done: n.mins >= b.end,
      minutesBudget: b.minutes,
    })),
    overflow, unplaced,
    counts: { open: open.length, placed: graded.length - overflow.length - unplaced.length,
      overflow: overflow.length, unplaced: unplaced.length },
  };
}

/** Edit one block. His model, so he owns the hours and the words. */
function save(patch) {
  const id = val(patch.id);
  if (!id) throw new Error('which block?');
  const rows = deps.readTSV('scope/blocks.tsv');
  const hit = rows.find(r => val(r.ID) === id);
  if (!hit) throw new Error(`no block called ${id}`);
  if (patch.start && toMins(patch.start) === null) throw new Error('start must read as HH:MM');
  if (patch.end && toMins(patch.end) === null) throw new Error('end must read as HH:MM');
  // Rest crosses midnight legitimately (21:00 to 05:00), so the end-after-start
  // rule below is waived for it and only for it.
  const mayWrap = String(val(hit.AXIS)).toLowerCase() === 'rest';
  const row = {
    ...hit,
    NAME: patch.name ? clean(patch.name).slice(0, 40) : hit.NAME,
    START: patch.start || hit.START,
    END: patch.end || hit.END,
    MATCH: patch.match !== undefined ? clean(patch.match).toLowerCase() : hit.MATCH,
    CAPACITY: patch.capacity !== undefined ? String(patch.capacity || '-') : hit.CAPACITY,
    ACTIVE: patch.active === false ? 'no' : patch.active === true ? 'yes' : hit.ACTIVE,
    NOTE: patch.note !== undefined ? clean(patch.note) : hit.NOTE,
  };
  if (!mayWrap && toMins(row.END) <= toMins(row.START)) throw new Error('a block has to end after it starts');
  deps.rewriteTSV('scope/blocks.tsv', all => all.map(r => (val(r.ID) === id ? row : r)));
  deps.auditLog?.('block_saved', { id, start: row.START, end: row.END });
  return row;
}

module.exports = { init, blocks, now, classify, plan, save, TASK_MINUTES };
