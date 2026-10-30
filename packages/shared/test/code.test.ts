import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanProjectPath, projectSlug } from '../src/index.ts';

test('project paths: plain text files inside the project only', () => {
  assert.equal(cleanProjectPath('index.html'), 'index.html');
  assert.equal(cleanProjectPath('./js/game.js'), 'js/game.js');
  assert.equal(cleanProjectPath('/style.css'), 'style.css');
  for (const bad of ['../secret.html', 'a/../../b.js', '.env', 'js/.hidden.js', 'run.sh', 'pic.png', 'a/b/c/d.js', 'C:\\\\x.js', 'index.html\0.js', '', 42]) {
    assert.equal(cleanProjectPath(bad), null, String(bad));
  }
  assert.equal(projectSlug('My Pond Clock!'), 'my-pond-clock');
  assert.equal(projectSlug('Über Teiche'), 'uber-teiche');
  assert.equal(projectSlug('???'), 'project');
});
