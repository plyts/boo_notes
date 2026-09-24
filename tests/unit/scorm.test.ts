import { describe, expect, it } from 'vitest';
import { applyScorm, readScormValue, scormDone, scormLabel, xapiValues, type ScormValue } from '../../src/shared/scorm';

const run = (values: Array<[string, string, string]>) =>
  values.reduce((s, [version, key, value]) => applyScorm(s, { version, key, value } as ScormValue), null as ReturnType<typeof applyScorm> | null)!;

describe('SCORM reports of a course module', () => {
  it('follows SCORM 2004: completion, success, progress, score, bookmark', () => {
    const s = run([
      ['2004', 'cmi.completion_status', 'incomplete'],
      ['2004', 'cmi.progress_measure', '0.4'],
      ['2004', 'cmi.location', 'slide-7'],
      ['2004', 'cmi.score.scaled', '0.85'],
    ]);
    expect(s).toEqual({ version: '2004', status: 'incomplete', progress: 0.4, score: 85, location: 'slide-7' });
    expect(scormLabel(s)).toBe('En cours · 40 % · score 85');
    const done = run([
      ['2004', 'cmi.completion_status', 'completed'],
      ['2004', 'cmi.success_status', 'passed'],
      ['2004', 'cmi.completion_status', 'completed'],
    ]);
    // A pass says more than « completed », and stays.
    expect(done.status).toBe('passed');
    expect(scormDone(done)).toBe(true);
    expect(scormLabel(done)).toBe('Réussi');
  });

  it('follows SCORM 1.2', () => {
    const s = run([
      ['1.2', 'cmi.core.lesson_status', 'incomplete'],
      ['1.2', 'cmi.core.lesson_location', '3'],
      ['1.2', 'cmi.core.score.raw', '72'],
      ['1.2', 'cmi.core.lesson_status', 'completed'],
    ]);
    expect(s).toMatchObject({ version: '1.2', status: 'completed', score: 72, location: '3' });
    expect(scormLabel(s)).toBe('Terminé · score 72');
  });

  it('reads xAPI statements (completed, progressed, score)', () => {
    const values = xapiValues([
      { verb: { id: 'http://adlnet.gov/expapi/verbs/progressed' }, result: { extensions: { 'https://w3id.org/xapi/cmi5/result/extensions/progress': 60 } } },
      { verb: { id: 'http://adlnet.gov/expapi/verbs/passed' }, result: { score: { scaled: 0.9 } } },
      { verb: { id: 'http://adlnet.gov/expapi/verbs/answered' } },
    ]);
    const s = values.reduce((acc, v) => applyScorm(acc, v), null as ReturnType<typeof applyScorm> | null)!;
    expect(s).toMatchObject({ version: 'xapi', status: 'passed', progress: 0.6, score: 90 });
  });

  it('checks what crosses from the page world', () => {
    expect(readScormValue(JSON.stringify({ version: '2004', key: 'cmi.location', value: 'p2' }))).toEqual({ version: '2004', key: 'cmi.location', value: 'p2' });
    // The module's own data is not followed.
    expect(readScormValue(JSON.stringify({ version: '2004', key: 'cmi.suspend_data', value: 'x' }))).toBeNull();
    expect(readScormValue({ key: 'cmi.location' })).toBeNull();
    expect(readScormValue('oops')).toBeNull();
  });
});
