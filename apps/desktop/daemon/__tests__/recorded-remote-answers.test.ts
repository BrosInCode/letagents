import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordedRemoteAnswers, REMOTE_ANSWERS_KEPT, REMOTE_ANSWER_USE_MS, REMOTE_FAILURE_PAUSE_MS, askRecordedRemote, setRemoteUnansweredReporter, type RemoteUnansweredSample } from '../recorded-remote-answers.js';

// A remote that is asked on purpose: each question waits until the test answers it.
function remotes() {
  const asked: Array<{ remote: string; answer(tips: string[] | null): Promise<void>; fail(): Promise<void> }> = [];
  let now = 1_000_000;
  const answers = new RecordedRemoteAnswers((remote) => new Promise((resolve, reject) => {
    const settle = async () => { await new Promise<void>(done => setImmediate(done)); };
    asked.push({ remote, answer: (tips) => { resolve(tips); return settle(); }, fail: () => { reject(new Error('the question broke')); return settle(); } });
  }), () => now);
  const pending = async (turn: Promise<unknown>) => {
    let settled = false;
    void turn.then(() => { settled = true; });
    await new Promise<void>(done => setImmediate(done));
    return !settled;
  };
  /** The answer of a turn that must not wait for the remote. A turn that waits fails here instead of hanging the test. */
  const atOnce = async (remote: string) => {
    const turn = answers.forTurn(remote);
    assert.equal(await pending(turn), false, 'the turn waits for the remote');
    return turn;
  };
  return { asked, answers, pending, atOnce, pass(ms: number) { now += ms; }, questions: (remote: string) => asked.filter(question => question.remote === remote).length };
}
const second = 1_000, minute = 60 * second;

test('the constants: an answer serves for a minute, and a remote that failed rests for five', () => {
  assert.equal(REMOTE_ANSWER_USE_MS, minute);
  assert.equal(REMOTE_FAILURE_PAUSE_MS, 5 * minute);
});

test('the first turn uses the answer in flight; turns in the next minute reuse it without asking', async () => {
  const f = remotes();
  const first = f.answers.forTurn('origin-a');
  assert.equal(f.asked.length, 1);
  assert.equal(await f.pending(first), true);
  await f.asked[0].answer(['one']);
  assert.deepEqual(await first, ['one']);
  f.pass(30 * second);
  assert.deepEqual(await f.atOnce('origin-a'), ['one']);
  f.pass(REMOTE_ANSWER_USE_MS - 30 * second - 1);
  assert.deepEqual(await f.atOnce('origin-a'), ['one']);
  assert.equal(f.asked.length, 1, 'no question while the answer is younger than a minute');
});

test('a turn that begins a minute or more after the answer asks, and has the new answer and not the old one', async () => {
  const f = remotes();
  const first = f.answers.forTurn('origin-a');
  await f.asked[0].answer(['one']); await first;
  f.pass(REMOTE_ANSWER_USE_MS);
  const turn = f.answers.forTurn('origin-a');
  assert.equal(f.asked.length, 2);
  assert.equal(await f.pending(turn), true, 'the old answer is not handed out');
  await f.asked[1].answer(['two']);
  assert.deepEqual(await turn, ['two']);
  f.pass(second);
  assert.deepEqual(await f.atOnce('origin-a'), ['two']);
  assert.equal(f.asked.length, 2, 'the new answer is young again');
});

test('turns that begin while a question is in flight join it: one question for a remote at a time', async () => {
  const f = remotes();
  const together = [f.answers.forTurn('origin-a'), f.answers.forTurn('origin-a')];
  f.pass(2 * second);
  const later = f.answers.forTurn('origin-a');
  assert.equal(f.asked.length, 1);
  await f.asked[0].answer(['one']);
  assert.deepEqual(await Promise.all([...together, later]), [['one'], ['one'], ['one']]);
});

test('a turn keeps the answer it had when it began, whatever the remote says later', async () => {
  const f = remotes();
  const first = f.answers.forTurn('origin-a');
  await f.asked[0].answer(['before the turn']);
  f.pass(2 * minute);
  const other = f.answers.forTurn('origin-a');
  await f.asked[1].answer(['before the turn', 'pushed by the first turn']);
  assert.deepEqual(await other, ['before the turn', 'pushed by the first turn']);
  assert.deepEqual(await first, ['before the turn']);
});

test('a remote that failed is left alone for five minutes, and turns in that time get no answer', async () => {
  const f = remotes();
  const first = f.answers.forTurn('origin-a');
  await f.asked[0].answer(null);
  assert.equal(await first, null);
  f.pass(REMOTE_FAILURE_PAUSE_MS - 1);
  assert.equal(await f.atOnce('origin-a'), null);
  assert.equal(f.asked.length, 1, 'not asked again');
  f.pass(1);
  const again = f.answers.forTurn('origin-a');
  assert.equal(f.asked.length, 2, 'asked again when the pause is over');
  await f.asked[1].fail();
  assert.equal(await again, null, 'a question that breaks is a failure, not an error for the turn');
  assert.equal(await f.atOnce('origin-a'), null);
  assert.equal(f.asked.length, 2);
});

test('an answer followed by a failure: the answer is too old by then, so the pause means no answer', async () => {
  const f = remotes();
  const first = f.answers.forTurn('origin-a');
  await f.asked[0].answer(['one']); await first;
  f.pass(REMOTE_ANSWER_USE_MS);
  const failed = f.answers.forTurn('origin-a');
  await f.asked[1].answer(null);
  assert.equal(await failed, null);
  f.pass(minute);
  assert.equal(await f.atOnce('origin-a'), null);
  assert.equal(f.asked.length, 2, 'the remote rests');
  f.pass(REMOTE_FAILURE_PAUSE_MS);
  const recovered = f.answers.forTurn('origin-a');
  await f.asked[2].answer(['three']);
  assert.deepEqual(await recovered, ['three']);
  assert.deepEqual(await f.atOnce('origin-a'), ['three']);
  assert.equal(f.asked.length, 3);
});

test('an answer is a minute young from the moment it arrives, however long the remote took', async () => {
  const f = remotes();
  const first = f.answers.forTurn('origin-a');
  f.pass(4 * second);
  await f.asked[0].answer(['one']); await first;
  f.pass(REMOTE_ANSWER_USE_MS - 1);
  assert.deepEqual(await f.atOnce('origin-a'), ['one']);
  assert.equal(f.asked.length, 1);
  f.pass(1);
  void f.answers.forTurn('origin-a');
  assert.equal(f.asked.length, 2);
});

test('a completed answer that is young enough is used even while the remote rests', async () => {
  const f = remotes();
  const first = f.answers.forTurn('origin-a');
  await f.asked[0].answer(['one']); await first;
  f.pass(REMOTE_ANSWER_USE_MS);
  const failed = f.answers.forTurn('origin-a');
  await f.asked[1].answer(null);
  assert.equal(await failed, null);
  // Only a clock that is set back brings a young answer and a pause together.
  f.pass(-30 * second);
  assert.deepEqual(await f.atOnce('origin-a'), ['one']);
  assert.equal(f.asked.length, 2);
});

test('an answer is kept for the remote that gave it and for no other', async () => {
  const f = remotes();
  const a = f.answers.forTurn('origin-a'), b = f.answers.forTurn('origin-b');
  assert.deepEqual(f.asked.map(question => question.remote), ['origin-a', 'origin-b']);
  await f.asked[1].answer(['from b']); await f.asked[0].answer(['from a']);
  assert.deepEqual([await a, await b], [['from a'], ['from b']]);
  assert.deepEqual([await f.atOnce('origin-a'), await f.atOnce('origin-b')], [['from a'], ['from b']]);
  const other = f.answers.forTurn('origin-c');
  assert.equal(await f.pending(other), true, 'a remote that was never asked has no answer of another');
  await f.asked[2].answer(null);
  assert.equal(await other, null);
});

test('only a bounded number of remotes is remembered, and forgetting one means asking it again', async () => {
  const f = remotes();
  for (let index = 0; index <= REMOTE_ANSWERS_KEPT; index++) {
    const turn = f.answers.forTurn(`origin-${index}`);
    await f.asked.at(-1)!.answer([`tip ${index}`]); await turn;
  }
  assert.deepEqual(await f.atOnce(`origin-${REMOTE_ANSWERS_KEPT}`), [`tip ${REMOTE_ANSWERS_KEPT}`]);
  assert.equal(f.questions(`origin-${REMOTE_ANSWERS_KEPT}`), 1, 'the newest is remembered');
  const forgotten = f.answers.forTurn('origin-0');
  assert.equal(f.questions('origin-0'), 2, 'the one used longest ago was forgotten');
  await f.asked.at(-1)!.answer(['tip 0 again']);
  assert.deepEqual(await forgotten, ['tip 0 again']);
  f.answers.clear();
  void f.answers.forTurn('origin-5');
  assert.equal(f.questions('origin-5'), 2, 'a cleared store remembers nothing');
});

test('a question without an answer is reported once, with its reason and the time it took; an answer is not', async t => {
  const samples: RemoteUnansweredSample[] = [];
  t.after(() => setRemoteUnansweredReporter(null));
  setRemoteUnansweredReporter(sample => { samples.push(sample); });
  let now = 0;
  const warned: string[] = [];
  const options = { clock: () => now, warn: (reason: string) => { warned.push(reason); } };

  assert.deepEqual(await askRecordedRemote('origin-a', async () => { now += 7_900; return ['tip']; }, options), ['tip']);
  assert.deepEqual([samples, warned], [[], []], 'a slow answer is an answer');

  // The remote stays silent up to the limit.
  assert.equal(await askRecordedRemote('origin-a', async (remote, onNoAnswer) => {
    assert.equal(remote, 'origin-a');
    now += 20_004; onNoAnswer('the remotes did not answer within 20 seconds');
    return null;
  }, options), null);
  assert.deepEqual(samples, [{ reason: 'the remotes did not answer within 20 seconds', elapsed_ms: 20_004, pause_ms: REMOTE_FAILURE_PAUSE_MS }]);
  assert.deepEqual(warned, ['the remotes did not answer within 20 seconds']);

  // A question that breaks, and one that gives no reason, are events too. Only a given reason is a warning.
  assert.equal(await askRecordedRemote('origin-a', async () => { now += 12; throw new Error('the question broke\nwith a second line'); }, options), null);
  assert.equal(await askRecordedRemote('origin-a', async () => null, options), null);
  assert.deepEqual(samples.slice(1), [{ reason: 'the question broke', elapsed_ms: 12, pause_ms: REMOTE_FAILURE_PAUSE_MS },
    { reason: 'the question gave no reason', elapsed_ms: 0, pause_ms: REMOTE_FAILURE_PAUSE_MS }]);
  assert.deepEqual(warned.slice(1), ['the question broke']);

  // Neither a reporter nor a warning that fails changes the answer, and without a reporter nothing is kept.
  setRemoteUnansweredReporter(() => { throw new Error('the log is gone'); });
  assert.equal(await askRecordedRemote('origin-a', async (_remote, onNoAnswer) => { onNoAnswer('no remote was recorded'); return null; },
    { warn: () => { throw new Error('stderr is gone'); } }), null);
  setRemoteUnansweredReporter(null);
  assert.equal(await askRecordedRemote('origin-a', async () => null), null);
  assert.equal(samples.length, 3);
});

test('a remote that fails is reported for the question only: the turns of the pause add nothing', async t => {
  const samples: RemoteUnansweredSample[] = [];
  t.after(() => setRemoteUnansweredReporter(null));
  setRemoteUnansweredReporter(sample => { samples.push(sample); });
  let now = 1_000_000;
  const answers = new RecordedRemoteAnswers((remote) => askRecordedRemote(remote, async (_address, onNoAnswer) => { onNoAnswer('Git could not ask the remote.'); return null; }), () => now);
  assert.equal(await answers.forTurn('origin-a'), null);
  now += 4 * minute;
  assert.equal(await answers.forTurn('origin-a'), null);
  assert.equal(samples.length, 1, 'the paused turn did not ask');
  now += minute;
  assert.equal(await answers.forTurn('origin-a'), null);
  assert.deepEqual(samples.map(sample => sample.reason), ['Git could not ask the remote.', 'Git could not ask the remote.']);
});

test('the daemon entrypoint writes the event to the lifecycle log, with stdio discarded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-unanswered-process-'));
  try {
    const path = join(directory, 'daemon-lifecycle.jsonl');
    const script = `
      import { startDaemonLifecycleDiagnostics } from ${JSON.stringify(new URL('../lifecycle-log.ts', import.meta.url).href)};
      import { askRecordedRemote } from ${JSON.stringify(new URL('../recorded-remote-answers.ts', import.meta.url).href)};
      startDaemonLifecycleDiagnostics(${JSON.stringify(path)});
      let now = 0;
      await askRecordedRemote('https://owner:secret-password@git.example.invalid/team/project', async (remote, onNoAnswer) => {
        now = 8200; onNoAnswer('Command failed: git ls-remote --get-url -- ' + remote); return null;
      }, { clock: () => now, warn: () => { throw new Error('stderr unavailable'); } });
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: 'ignore', timeout: 30_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0);
    const text = await readFile(path, 'utf8');
    const events = text.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.event), ['daemon_starting', 'workspace_remote_unanswered', 'process_exit']);
    const detail = JSON.parse(events[1].detail);
    assert.deepEqual([detail.elapsed_ms, detail.pause_ms], [8200, REMOTE_FAILURE_PAUSE_MS]);
    assert.match(detail.reason, /^Command failed: git ls-remote --get-url -- /);
    assert.doesNotMatch(text, /secret-password/, 'a credential in the remote\'s address does not reach the log');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
