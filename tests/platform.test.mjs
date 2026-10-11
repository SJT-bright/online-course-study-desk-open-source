import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toolPath } from '../lib/platform.mjs';
import { uiSocketPath } from '../lib/desktop-window.mjs';
test('Windows tool lookup supports spaces, .exe and explicit overrides', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'sd tools 中文-'));
  try {
    const file = path.join(dir,'ffmpeg.exe'); fs.writeFileSync(file,'fixture');
    assert.equal(toolPath(['ffmpeg'], { platform:'win32', env:{PATH:dir} }),file);
    assert.equal(toolPath(['ffmpeg'], { platform:'win32', env:{PATH:'',STUDYDESK_FFMPEG:file},envName:'STUDYDESK_FFMPEG' }),file);
    assert.equal(toolPath(['missing'], { platform:'win32', env:{PATH:dir} }),null);
    const pipe = uiSocketPath(dir,'win32'); assert.match(pipe,/^\\\\\.\\pipe\\studydesk-ui-/);
    assert.notEqual(pipe,uiSocketPath(dir+'other','win32'));
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
