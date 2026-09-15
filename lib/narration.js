'use strict';
/**
 * Course narration: markdown module -> spoken script -> Chatterbox audio.
 *
 * Voice: narrator_female, a clear/intimate/warm voice clone -- chosen for
 * clarity over character so the read stays even across a 10-20 minute
 * module rather than drifting expressive/unstable on long-form text.
 * Self-hosted via the bundled Chatterbox engine (zero cost, unlimited,
 * deterministic voice clone) -- 15 Sep 2026: the ElevenLabs fallback path
 * this module used to carry was removed entirely, per Sconl's standing
 * instruction to drop every ElevenLabs reference in favour of an
 * open-source alternative. It had already gone unused in practice --
 * the only real call site (vault/src/server.js) never passed an API key.
 */

const crypto = require('crypto');

const VOICE_ID = 'narrator_female';
const VOICE_NAME = 'Clara Louise';

function contentHash(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex').slice(0, 16);
}

/**
 * Turn one module's markdown into a script meant to be HEARD, not read -
 * a listener with no screen should still get the title, the callouts (as
 * spoken cues, "Here's a term worth knowing:") and a plain description of
 * any chart/map/image rather than dead air or a citation bracket read
 * aloud as syntax.
 */
function mdToScript(title, subtitle, mdText) {
  const lines = String(mdText || '').split(/\r?\n/);
  const spoken = [];

  if (title) spoken.push(`${title}.`);
  if (subtitle) spoken.push(`${subtitle}.`);

  const CALLOUT_SPOKEN = [
    [/^\*\*(You will be able to|What you will learn|What will be learnt):?\*\*\s*/i, 'Here is what you will be able to do after this module. '],
    [/^\*\*(Watch for|What to watch for|Watch out for|Careful):?\*\*\s*/i, 'Something to watch for: '],
    [/^\*\*(Jargon|In plain language|Plain language|The word):?\*\*\s*/i, 'A term worth knowing: '],
    [/^\*\*(In a book|Book):?\*\*\s*/i, 'Worth reading further: '],
    [/^\*\*Book quote:?\*\*\s*/i, 'A quote worth remembering. '],
    [/^\*\*Research:?\*\*\s*/i, 'Backing this up with real research: '],
    [/^\*\*Fun fact:?\*\*\s*/i, 'Here is a fun fact. '],
  ];

  let i = 0;
  let inFence = null; // 'chart' | 'map' | 'code'
  let fenceBuf = [];
  while (i < lines.length) {
    let line = lines[i];

    const fenceOpen = line.match(/^```(chart|map)?\s*$/);
    if (fenceOpen && !inFence) {
      inFence = fenceOpen[1] || 'code';
      fenceBuf = [];
      i++; continue;
    }
    if (inFence) {
      if (/^```\s*$/.test(line)) {
        if (inFence === 'chart') {
          const t = fenceBuf.find(l => /^title:/i.test(l));
          spoken.push(`There is a chart here${t ? `, showing ${t.replace(/^title:\s*/i, '')}` : ''}. The numbers are on screen for anyone reading along.`);
        } else if (inFence === 'map') {
          const label = fenceBuf.find(l => /^label:/i.test(l));
          spoken.push(`There is a map here${label ? `, centred on ${label.replace(/^label:\s*/i, '')}` : ''}.`);
        }
        inFence = null; fenceBuf = [];
        i++; continue;
      }
      fenceBuf.push(line);
      i++; continue;
    }

    // Images: ![alt](path) - speak the alt text, skip the markdown syntax.
    const img = line.match(/!\[([^\]]*)\]\(([^)]*)\)/);
    if (img) {
      spoken.push(img[1] ? `There is an image here: ${img[1]}.` : 'There is an image here.');
      i++; continue;
    }

    // Equations: describe rather than read raw LaTeX aloud.
    if (/\$\$[\s\S]*?\$\$/.test(line) || /\$[^$]+\$/.test(line)) {
      const withoutMath = line.replace(/\$\$[\s\S]*?\$\$/g, '').replace(/\$[^$]+\$/g, '').trim();
      if (withoutMath) spoken.push(`${withoutMath} There is a formula here on screen for the exact figures.`);
      else spoken.push('There is a formula here on screen for the exact figures.');
      i++; continue;
    }

    let matchedCallout = false;
    for (const [re, prefix] of CALLOUT_SPOKEN) {
      if (re.test(line)) {
        // Join wrapped continuation lines the same way the on-screen parser does.
        let text = line.replace(re, '');
        let j = i + 1;
        while (j < lines.length && lines[j].trim() && !/^\*\*[A-Za-z ]+:?\*\*/.test(lines[j]) && !/^#/.test(lines[j])) {
          text += ' ' + lines[j];
          j++;
        }
        text = text.replace(/\[([^\]]+)\]\s*$/, '(source: $1)');
        spoken.push(prefix + text.trim());
        i = j;
        matchedCallout = true;
        break;
      }
    }
    if (matchedCallout) continue;

    if (/^#{1,4}\s/.test(line)) {
      spoken.push(line.replace(/^#{1,4}\s*/, '') + '.');
      i++; continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { i++; continue; }
    if (!line.trim()) { i++; continue; }

    // Strip remaining markdown syntax (bold/italic/links/list markers).
    const plain = line
      .replace(/^[-*]\s+/, '')
      .replace(/^\d+\.\s+/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1');
    if (plain.trim()) spoken.push(plain.trim());
    i++;
  }

  return spoken.join('\n\n');
}

const CHATTERBOX_URL = process.env.CHATTERBOX_URL || 'http://127.0.0.1:5001/v1/audio/speech';

/**
 * Audio synthesis via the self-hosted, open-source Chatterbox engine.
 * The only provider -- 15 Sep 2026: the ElevenLabs fallback was removed
 * entirely, per Sconl's standing instruction to drop every ElevenLabs
 * reference in favour of an open-source alternative.
 */
async function synthesize(scriptText, { voiceId = VOICE_ID, seed = 482193 } = {}) {
  const res = await fetch(CHATTERBOX_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: scriptText,
      voice: voiceId,
      response_format: 'mp3',
      seed,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Chatterbox TTS failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

module.exports = { VOICE_ID, VOICE_NAME, CHATTERBOX_URL, contentHash, mdToScript, synthesize };
