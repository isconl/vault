'use strict';
/**
 * The vault's expected shape -- one entry per collection, across every engine.
 *
 * Ported verbatim from isconl-agent's server.js VAULT_SCHEMA. Kept as ONE
 * registry for now (rather than splitting per-engine) because during the
 * transition a single `vault` service still backs every engine's storage --
 * splitting the registry itself can happen once engines actually run as
 * separate deployments and need to register their own collections
 * independently. createVaultStore() accepts a schema override/extension, so
 * that split is additive whenever it happens, not a rewrite.
 *
 * memory/ (the directory these paths are relative to) is deliberately not in
 * git -- it holds private material -- which means a fresh clone or a fresh
 * deploy starts with no vault files at all. readTSV happily returns [] for a
 * missing file, so every list would simply look empty, but a write to a
 * missing file used to be a silent no-op -- creating a record on a new host
 * did nothing, with no error. Declaring the schema lets a new host bootstrap
 * itself into a working state instead (see ensureVault in store.js).
 */
module.exports = {
  // Tasks: TAG marks which part of life a task belongs to (an org, personal,
  // or an axial space). ASSIGNEE and START_DATE exist so a task carries its
  // own timeline/owner before it's ever pushed anywhere. DONE_AT stamps
  // completion, making the archive filterable by time. PARENT_ID: set on a
  // subtask, '-' on a main task, one level deep only. WHY and RESOLUTION:
  // every task explains itself in plain language; a task without a WHY is a
  // data-health flag. DELIVERY is a SEPARATE handover ledger from STATUS --
  // a deliverable moves drafted -> reviewed -> sent, and none of those is
  // "done"; only the owner closes a task, and sending it onward isn't the
  // same as it being accepted. DELIVERABLE: files this task actually
  // produced, pipe-separated, primary document first -- certainty over a
  // keyword-search guess. SEQ/SEQ_WHY: the board's order and why.
  'scope/tasks.tsv': 'ID\tTITLE\tSTATUS\tPRIORITY\tPROJECT_ID\tCARRY_FWD\tDUE_DATE\tCREATED_AT\tJIRA_KEY\tORIGIN\tTAG\tSTART_DATE\tASSIGNEE\tDONE_AT\tPARENT_ID\tWHY\tRESOLUTION\tDELIVERY\tSENT_TO\tSENT_AT\tSENT_VIA\tDELIVERY_NOTE\tSEQ\tSEQ_WHY\tDELIVERABLE\tASSIGNED_BY',
  // TAG carries the same vocabulary as tasks. COMMENT is the operator's own
  // margin note, and doubles as steering for a generated reply.
  'scope/inbox.tsv': 'ID\tTITLE\tBODY\tSTATUS\tSOURCE\tCAPTURED_AT\tCHANNEL\tSENDER\tSUBJECT\tRECEIVED_AT\tTAG\tCOMMENT',
  // Circle: relationship management. people.tsv is the registry,
  // interactions.tsv the touch ledger; per-person DIA profiles are markdown
  // files elsewhere. Private by nature. REMEMBER: standing facts about a
  // person that must never be forgotten -- how they take news, a
  // sensitivity, something got wrong once -- semicolon-separated, one per
  // line. NOTE is the current state of the relationship; REMEMBER is what
  // stays true regardless of state.
  'circle/people.tsv': 'ID\tNAME\tCIRCLE\tGROUP\tROLE\tMET\tCHANNEL\tLAST_TOUCH\tCADENCE_DAYS\tSTATUS\tFOLDER\tNOTE\tREMEMBER',
  'circle/interactions.tsv': 'ID\tPERSON_ID\tDATE\tCHANNEL\tSUMMARY\tNEXT\tCREATED_AT',
  // The social graph. capabilities.tsv: what each person can help with, with
  // evidence (never guessed). graph.tsv: edges between people (knows,
  // works-with, reports-to, family) so "who can help with X" can answer
  // adjacently -- one hop from a capability is a warm path to it.
  'circle/capabilities.tsv': 'PERSON_ID\tCAPABILITY\tSTRENGTH\tEVIDENCE',
  'circle/graph.tsv': 'FROM_ID\tTO_ID\tREL\tNOTE',
  // Learning: courses the agent builds and teaches. Course CONTENT is
  // markdown elsewhere; these are the registry and progress ledger.
  // CLASSROOM groups related courses; LEVEL states the arc (defaults
  // beginner-to-expert -- a course that assumes prior knowledge is a
  // reference, not a course).
  'learning/courses.tsv': 'ID\tTITLE\tGOAL\tSTATUS\tLESSON_COUNT\tCREATED_AT\tUPDATED_AT\tNOTE\tCLASSROOM\tLEVEL\tSUBTITLE',
  'learning/progress.tsv': 'COURSE_ID\tLESSON\tSTATUS\tUPDATED_AT',
  // Where the learner actually IS in each course -- lesson plus scroll
  // depth, stamped to the second, so "continue where you left off" reopens
  // the exact spot. One row per course; the newest stamp across rows is the
  // global resume point.
  'learning/resume.tsv': 'COURSE_ID\tLESSON\tSCROLL_PCT\tUPDATED_AT',
  // Ideas pipeline. STAGE: captured -> shaping -> committed -> shipped, plus
  // parked. TYPE separates an improvement to the agent itself from a
  // product or venture idea. IMPACT/EFFORT: 1-10 scores, the same lever
  // pair finance uses, so the list ranks itself. SOURCE: where it came in
  // from (chat, ui, telegram), distinguishing a captured-in-passing thought
  // from a considered one.
  'spark/ideas.tsv': 'ID\tTITLE\tBODY\tSTAGE\tTYPE\tDOMAIN\tTAGS\tIMPACT\tEFFORT\tSTATUS\tSOURCE\tCREATED_AT\tUPDATED_AT\tAI_NOTE\tNOTE\tLINKS',
  'spark/dia.tsv': 'ID\tENTRY\tCREATED_AT',
  // Journal. BODY and AI_NOTE are TSV-escaped (tab -> two spaces, newline ->
  // literal \n); the journal endpoints handle the escaping both ways.
  'spark/journal.tsv': 'ID\tDATE\tMOOD\tENERGY\tTAGS\tBODY\tAI_NOTE\tCREATED_AT',
  // Chat threads -- the transcript is part of the record, not a buffer that
  // dies with the process, so it survives a restart.
  'spark/chats.tsv': 'ID\tTITLE\tCREATED_AT\tUPDATED_AT\tCOUNT\tSTATUS',
  'spark/chat_messages.tsv': 'ID\tTHREAD_ID\tROLE\tCONTENT\tTS',
  'space/spaces.tsv': 'ID\tPARENT_ID\tNAME\tLABEL\tKIND\tAXIS\tONEDRIVE_PATH\tTYPE\tSTATUS\tHEALTH\tDESCRIPTION\tLAST_REVIEWED\tVIEW',
  'copilot/decisions.tsv': 'ID\tTITLE\tSTATUS\tOWNER\tRAISED_AT\tNOTE',
  'copilot/risks.tsv': 'ID\tTITLE\tSEVERITY\tTRIPWIRE\tNOTE',
  // Personal finance: category + vendor, plus 1-10 necessity/satisfaction
  // scores -- the actual levers a spending review uses. Plane B without
  // exception.
  // Important personal dates -- birthdays, anniversaries, renewals. Starts
  // empty and fills from the operator, never from guessed filenames. MM-DD
  // for recurring dates, full YYYY-MM-DD for one-offs.
  'scope/dates.tsv': 'ID\tTITLE\tDATE\tKIND\tWHO\tRECURS\tCOLOR\tNOTE',
  // Notifications: the one place everything that wants attention lands, from
  // every source. Append-only and never pruned -- the history IS the
  // pattern. STATUS moves new -> seen -> acted; DEDUPE_KEY is the natural
  // identity of the underlying fact, so a sweep that runs periodically
  // re-notices without re-notifying.
  'notifications.tsv': 'ID\tTS\tSOURCE\tKIND\tSEVERITY\tTITLE\tBODY\tVIEW\tREF\tSTATUS\tDEDUPE_KEY\tSEEN_AT',
  // Plans: goals stated in the operator's own words, distilled into dated
  // tasks that carry ORIGIN plan:<id> -- the same provenance discipline as
  // tasks distilled from messages.
  'scope/plans.tsv': 'ID\tTITLE\tHORIZON\tTAG\tSTATUS\tCREATED_AT\tNOTE',
  // Income streams. DAY: day of month it lands (or a full date for
  // one-offs). MATCH: the word that ties a logged transaction back to its
  // stream, so "received or overdue" is computable rather than guessed.
  // STARTS: first month (YYYY-MM) the stream is expected.
  'finance/incomes.tsv': 'ID\tNAME\tSOURCE\tAMOUNT\tCURRENCY\tRECURS\tDAY\tACCOUNT_ID\tMATCH\tSTATUS\tSTARTS\tNOTE',
  // Ventures: products/projects, each exposing a small metrics endpoint.
  // AUTH_SECRET names a secret-store key, never a value. RENDER_URL: the
  // deployed instance a project's space health-checks. FOLDER: the
  // project's cloud-storage home. GITHUB: owner/repo when applicable.
  // CATEGORY: portfolio (client/app work) / product (monetizable) /
  // platform (business infrastructure).
  'finance/ventures.tsv': 'ID\tNAME\tKIND\tANALYTICS_URL\tAUTH_SECRET\tSTATUS\tNOTE\tRENDER_URL\tFOLDER\tGITHUB\tCATEGORY',
  'finance/accounts.tsv': 'ID\tNAME\tTYPE\tINSTITUTION\tCURRENCY\tBALANCE\tASOF\tNOTE',
  'finance/transactions.tsv': 'ID\tDATE\tTYPE\tAMOUNT\tCURRENCY\tCATEGORY\tDESCRIPTION\tACCOUNT_ID\tVENDOR\tNECESSITY\tSATISFACTION\tTAGS\tNOTE',
  'finance/networth.tsv': 'DATE\tASSETS\tLIABILITIES\tNET\tNOTE',
  'finance/goals.tsv': 'ID\tTITLE\tTARGET\tCURRENT\tDUE\tSTATUS\tNOTE',
};
