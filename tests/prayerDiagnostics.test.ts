import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiHandler, HttpError } from '../src/server/http.ts';

test('diagnóstico de HTTP400 sólo registra código cerrado y correlación sin solicitud ni contenido', async t => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (line: string) => {lines.push(line);});
  for (const code of ['INVALID_PRAYER', 'INVALID_PATH']) {
    const response = await apiHandler(() => {throw new HttpError(400, code, 'contenido sensible');})(new Request('https://fixture.invalid/users/identidad-privada/prayers?cursor=0', {headers: {Authorization: 'Bearer secreto'}}));
    const body = await response.json();
    const log = JSON.parse(lines.at(-1)!);
    assert.deepEqual(log, {event: 'api_rejection', requestId: body.error.requestId, status: 400, code});
    assert.equal(log.requestId, response.headers.get('x-request-id'));
  }
  assert.equal(lines.length, 2);
  assert.ok(!lines.join('').match(/secreto|sensible|identidad-privada|fixture/));
});
