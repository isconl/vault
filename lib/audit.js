'use strict';
/**
 * Hash-chained, append-only audit log.
 *
 * Ported from isconl-agent's server.js (originally a module-level closure over
 * a single global LOGS_DIR). Now a factory so each caller supplies its own log
 * directory explicitly instead of relying on a shared global -- the engine
 * split means several processes may each want their own audit trail, or a
 * shared one passed in by the orchestrating hub.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Credential shapes that must never reach the audit log, whatever a caller
// passes. The audit log is the one file most likely to be read aloud
// somewhere else (and synced to cloud storage), so redaction belongs HERE as
// well as at the call site -- defence in depth, at the boundary.
const AUDIT_SECRET_SHAPES = [
  /\b\d{8,10}:AA[A-Za-z0-9_\-]{30,}/g,                  // Telegram bot token
  /\bsk-ant-[A-Za-z0-9_\-]{20,}/g,                      // Anthropic
  /\bgsk_[A-Za-z0-9]{40,}/g,                            // Groq
  /\bAIza[0-9A-Za-z_\-]{30,}/g,                         // Google
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,          // GitHub PAT
  /\bgithub_pat_[A-Za-z0-9_]{50,}/g,
  /\bATATT3[A-Za-z0-9_\-=]{40,}/g,                      // Atlassian
  /\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]*/g, // JWT
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----[\s\S]*?-----END[^-]*-----/g,
];

/** Replace any credential-shaped run with a marker that says what was removed. */
function auditRedact(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const re of AUDIT_SECRET_SHAPES) out = out.replace(re, '[redacted-secret]');
    return out;
  }
  if (Array.isArray(value)) return value.map(auditRedact);
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) {
      // A field NAMED like a secret is redacted whole, whatever its shape -
      // a short token would slip past the patterns above.
      o[k] = /token|secret|password|passwd|api[_-]?key|apikey|credential|private[_-]?key/i.test(k)
        ? '[redacted-secret]' : auditRedact(v);
    }
    return o;
  }
  return value;
}

/**
 * @param {object} opts
 * @param {string} opts.logsDir - directory the audit file lives in (created if missing)
 * @param {string} [opts.fileName='actions.jsonl']
 */
function createAuditLog({ logsDir, fileName = 'actions.jsonl' }) {
  if (!logsDir) throw new Error('createAuditLog requires logsDir');
  fs.mkdirSync(logsDir, { recursive: true });
  const auditFile = path.join(logsDir, fileName);

  // The chain continues from the file's actual tail rather than restarting at
  // 'genesis' on every boot. Seeding per-process would leave one 'genesis'
  // entry per restart -- each process's chain is internally perfect, but a
  // linear verifier would see every restart as a break, so on a day with
  // several restarts the audit view would report phantom chain breaks over
  // an otherwise intact record.
  let lastHash = 'genesis';
  try {
    const tail = fs.readFileSync(auditFile, 'utf8').trimEnd();
    const lastLine = tail.slice(tail.lastIndexOf('\n') + 1);
    const prev = JSON.parse(lastLine);
    if (prev && typeof prev.hash === 'string' && prev.hash.length >= 12) lastHash = prev.hash;
  } catch { /* first boot ever, or an empty log - genesis is correct */ }

  function log(action, meta = {}) {
    const entry = {
      ts: new Date().toISOString(),
      action,
      ...auditRedact(meta),
      prev_hash: lastHash,
    };
    const raw = JSON.stringify(entry);
    lastHash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
    entry.hash = lastHash;
    try { fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n'); } catch {}
    return entry;
  }

  /** Walk the whole file and confirm every entry's hash matches its content and chains to the prior one. Returns { ok, brokenAt } -- brokenAt is the 1-indexed line number of the first break, or null. */
  function verifyChain() {
    let expectedPrev = 'genesis';
    let lines;
    try {
      lines = fs.readFileSync(auditFile, 'utf8').trimEnd().split('\n').filter(Boolean);
    } catch {
      return { ok: true, brokenAt: null };   // no file yet is a valid (empty) chain
    }
    for (let i = 0; i < lines.length; i++) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { return { ok: false, brokenAt: i + 1 }; }
      if (entry.prev_hash !== expectedPrev) return { ok: false, brokenAt: i + 1 };
      const { hash, ...rest } = entry;
      const recomputed = crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 12);
      if (recomputed !== hash) return { ok: false, brokenAt: i + 1 };
      expectedPrev = hash;
    }
    return { ok: true, brokenAt: null };
  }

  return { log, verifyChain, auditRedact, auditFile };
}

module.exports = { createAuditLog, auditRedact };
