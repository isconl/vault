'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { listEvents, getEvent, createEvent } = require('../lib/google-calendar');

function fakeGoogle(handler) {
  const calls = [];
  return { calls, googleRequest: async (hostname, path, opts) => { calls.push({ hostname, path, opts }); return handler(hostname, path, opts); } };
}

test('listEvents hits calendars/primary/events with singleEvents+orderBy, maps items to the local event shape', async () => {
  const google = fakeGoogle(() => ({
    status: 200,
    data: { items: [
      { id: 'e1', summary: 'Standup', start: { dateTime: '2026-08-31T09:00:00+03:00' }, location: 'Zoom' },
      { id: 'e2', summary: 'All-day thing', start: { date: '2026-09-01' } },
    ] },
  }));
  const r = await listEvents(google, { timeMin: '2026-08-24T00:00:00Z' });
  assert.equal(r.ok, true);
  assert.equal(google.calls[0].hostname, 'www.googleapis.com');
  assert.match(google.calls[0].path, /^\/calendar\/v3\/calendars\/primary\/events\?/);
  assert.match(google.calls[0].path, /singleEvents=true/);
  assert.match(google.calls[0].path, /timeMin=2026-08-24/);
  assert.equal(r.events.length, 2);
  assert.equal(r.events[0].title, 'Standup');
  assert.equal(r.events[0].date, '2026-08-31');
  assert.equal(r.events[0].time, '09:00');
  assert.equal(r.events[0].location, 'Zoom');
  assert.equal(r.events[0].source, 'google');
  assert.equal(r.events[1].date, '2026-09-01');
  assert.equal(r.events[1].time, '');
});

test('listEvents surfaces a non-200 as ok:false without throwing', async () => {
  const google = fakeGoogle(() => ({ status: 401, data: { error: { message: 'Google account not connected.' } } }));
  const r = await listEvents(google);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test('getEvent fetches one event by id and maps it the same way', async () => {
  const google = fakeGoogle((hostname, path) => {
    assert.equal(path, '/calendar/v3/calendars/primary/events/e1');
    return { status: 200, data: { id: 'e1', summary: 'Standup', start: { dateTime: '2026-08-31T09:00:00Z' }, description: 'weekly sync' } };
  });
  const r = await getEvent(google, 'e1');
  assert.equal(r.ok, true);
  assert.equal(r.title, 'Standup');
  assert.equal(r.description, 'weekly sync');
});

test('createEvent requires title and date', async () => {
  const google = fakeGoogle(() => ({ status: 200, data: { id: 'new' } }));
  assert.equal((await createEvent(google, { date: '2026-08-31' })).ok, false);
  assert.equal((await createEvent(google, { title: 'x' })).ok, false);
});

test('createEvent with a time defaults to a 30-minute block (Google rejects zero-duration timed events)', async () => {
  const google = fakeGoogle((hostname, path, opts) => {
    assert.equal(opts.method, 'POST');
    assert.equal(opts.body.start.dateTime, '2026-08-31T09:00:00');
    assert.equal(opts.body.end.dateTime, '2026-08-31T09:30:00');
    return { status: 200, data: { id: 'new-event' } };
  });
  const r = await createEvent(google, { title: 'Standup with Alex', date: '2026-08-31', time: '09:00' });
  assert.equal(r.ok, true);
  assert.equal(r.id, 'new-event');
});

test('createEvent with no time creates an all-day event', async () => {
  const google = fakeGoogle((hostname, path, opts) => {
    assert.deepEqual(opts.body.start, { date: '2026-09-01' });
    assert.deepEqual(opts.body.end, { date: '2026-09-01' });
    return { status: 200, data: { id: 'all-day' } };
  });
  const r = await createEvent(google, { title: 'Deadline', date: '2026-09-01' });
  assert.equal(r.ok, true);
});

test('createEvent surfaces a non-200 as ok:false', async () => {
  const google = fakeGoogle(() => ({ status: 403, data: { error: { message: 'insufficient permissions' } } }));
  const r = await createEvent(google, { title: 'x', date: '2026-08-31' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});
