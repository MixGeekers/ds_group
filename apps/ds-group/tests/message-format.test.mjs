import test from 'node:test';
import assert from 'node:assert/strict';
import {messageParts} from '../web/src/message-format.ts';
const links=text=>messageParts(text).filter(p=>p.kind==='link').map(({text,href})=>({text,href}));
test('actual research Markdown links exclude delimiters and adjacent Chinese prose',()=>{
  assert.deepEqual(links('见[第 2 节](https://www.rfc-editor.org/rfc/rfc4180.html#section-2)，原文如下。'),
    [{text:'第 2 节',href:'https://www.rfc-editor.org/rfc/rfc4180.html#section-2'}]);
});
test('bare links leave punctuation in the surrounding message',()=>{
  const parts=messageParts('原文：https://www.w3.org/TR/WCAG22/，还有 (https://nodejs.org/api/test.html).');
  assert.deepEqual(parts.filter(p=>p.kind==='link').map(p=>p.href),['https://www.w3.org/TR/WCAG22/','https://nodejs.org/api/test.html']);
  assert.equal(parts.map(p=>p.text).join(''),'原文：https://www.w3.org/TR/WCAG22/，还有 (https://nodejs.org/api/test.html).');
});
test('balanced parentheses inside URLs remain part of the destination',()=>{
  const url='https://example.org/Function_(mathematics)';
  assert.equal(links(`[函数](${url})`)[0].href,url);
  assert.equal(links(`(${url})`)[0].href,url);
});
test('code stays literal and unsupported link schemes stay text',()=>{
  assert.equal(links('`https://example.org`\n```txt\nhttps://example.net\n```\n[x](javascript:alert(1))').length,0);
  assert.equal(messageParts('**完成**')[0].kind,'strong');
});
