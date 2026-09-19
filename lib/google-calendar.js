'use strict';
/**
 * Google Calendar wrapper calls on top of google.js's googleRequest --
 * BG26082005's Calendar half (the Gmail half shipped as BM26082011's
 * gmail.js, same sibling pattern deliberately mirrored here: three thin
 * functions, no pagination beyond one page since this is a poll/merge
 * consumer, not a one-time full-calendar import).
 */

const CALENDAR_HOST = 'www.googleapis.com';

/** List events on the primary calendar within [timeMin, timeMax] (ISO 8601, both optional -- Google defaults to "now onward" when timeMin is omitted). */
async function listEvents(google, { timeMin, timeMax, maxResults = 50 } = {}) {
  const params = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: String(maxResults) });
  if (timeMin) params.set('timeMin', timeMin);
  if (timeMax) params.set('timeMax', timeMax);
  const res = await google.googleRequest(CALENDAR_HOST, `/calendar/v3/calendars/primary/events?${params.toString()}`);
  if (res.status !== 200) return { ok: false, status: res.status, error: res.data?.error?.message || 'list failed' };
  const events = (res.data.items || []).map(e => ({
    id: e.id,
    title: e.summary || 'Untitled',
    date: (e.start?.dateTime || e.start?.date || '').slice(0, 10),
    time: e.start?.dateTime ? e.start.dateTime.slice(11, 16) : '',
    location: e.location || '',
    source: 'google',
  }));
  return { ok: true, events };
}

/** Fetch one event by id. */
async function getEvent(google, id) {
  const res = await google.googleRequest(CALENDAR_HOST, `/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`);
  if (res.status !== 200) return { ok: false, status: res.status, error: res.data?.error?.message || 'get failed' };
  const e = res.data;
  return {
    ok: true,
    id: e.id,
    title: e.summary || 'Untitled',
    date: (e.start?.dateTime || e.start?.date || '').slice(0, 10),
    time: e.start?.dateTime ? e.start.dateTime.slice(11, 16) : '',
    location: e.location || '',
    description: e.description || '',
  };
}

/** Create an event. `date`+`time` (local, no timezone math here -- caller's own local day/time, matching pulse/lib/calendar.js's local-event shape) or an all-day `date`-only event when `time` is omitted. */
async function createEvent(google, { title, date, time, description, location } = {}) {
  if (!title) return { ok: false, error: 'title required' };
  if (!date) return { ok: false, error: 'date required' };
  const body = { summary: title };
  if (description) body.description = description;
  if (location) body.location = location;
  if (time) {
    // Google rejects a zero-duration timed event (end must be strictly
    // after start) -- pulse's own local events store no end time at all,
    // so this defaults to a 30-minute block rather than guessing a real
    // duration; caller can PATCH a longer one later if needed.
    const [h, m] = time.split(':').map(Number);
    const startDateTime = `${date}T${time}:00`;
    const endMinutes = h * 60 + m + 30;
    const endTime = `${String(Math.floor(endMinutes / 60) % 24).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;
    body.start = { dateTime: startDateTime };
    body.end = { dateTime: `${date}T${endTime}:00` };
  } else {
    body.start = { date };
    body.end = { date };
  }
  const res = await google.googleRequest(CALENDAR_HOST, '/calendar/v3/calendars/primary/events', { method: 'POST', body });
  if (res.status !== 200) return { ok: false, status: res.status, error: res.data?.error?.message || 'create failed' };
  return { ok: true, id: res.data.id };
}

module.exports = { listEvents, getEvent, createEvent };
