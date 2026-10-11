import test from 'node:test';
import assert from 'node:assert/strict';
import { appDocumentAllowed } from '../lib/app-shell.mjs';

const token = 'abc123';

test('browser navigation does not receive the app page', () => {
  assert.equal(appDocumentAllowed({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, token), false);
  assert.equal(appDocumentAllowed({ 'sec-fetch-dest': 'iframe' }, token), false);
});

test('the local app shell and same-machine tools can receive the page', () => {
  assert.equal(appDocumentAllowed({ 'x-studydesk-shell': token, 'sec-fetch-mode': 'navigate' }, token), true);
  assert.equal(appDocumentAllowed({ cookie: 'other=1; sd_shell=abc123', 'sec-fetch-mode': 'navigate' }, token), true);
  assert.equal(appDocumentAllowed({}, token), true);
  assert.equal(appDocumentAllowed({ cookie: 'sd_shell=nope', 'sec-fetch-mode': 'navigate' }, token), false);
});
