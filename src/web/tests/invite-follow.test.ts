import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope } from 'vue'

import { inviteFromRefusal, useFollowedRoomInvite } from '../src/composables/room/invites'

type Listener = (event: { data?: string }) => void

/** A stand-in for the account stream: the test fires its events. */
class FakeStream {
  listeners = new Map<string, Listener[]>()
  closed = false
  /** 0 connecting, 1 open, 2 closed (the browser gave up). */
  readyState = 0
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  close() {
    this.closed = true
  }
  fire(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(data === undefined ? {} : { data: JSON.stringify(data) })
  }
}

class FakeWindow {
  listeners = new Set<() => void>()
  addEventListener(_type: string, listener: () => void) {
    this.listeners.add(listener)
  }
  removeEventListener(_type: string, listener: () => void) {
    this.listeners.delete(listener)
  }
  focus() {
    for (const listener of this.listeners) listener()
  }
}

function invite(id: string, state: 'open' | 'used' | 'cancelled' | 'expired', outcome: 'admitted' | 'requested' | null = null) {
  return {
    id,
    room_id: 'PTGA-21RN-W0QP',
    room_display_name: 'sky-owl',
    origin_room_id: 'PTGA-21RN-W0QP',
    platform: 'grok',
    kind: 'admit',
    state,
    outcome,
    created_at: '2026-11-16T23:32:05.550Z',
    expires_at: '2026-11-23T23:32:05.550Z',
    used_at: state === 'used' ? '2026-11-16T23:32:23.673Z' : null,
    used_by_login: state === 'used' ? 'EmmyMay' : null,
  } as const
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness(read: (room: string, id: string) => Promise<unknown> = async () => null) {
  const streams: FakeStream[] = []
  const reads: string[] = []
  const win = new FakeWindow()
  const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = []
  const scope = effectScope()
  const followed = scope.run(() => useFollowedRoomInvite(() => 'PTGA-21RN-W0QP', {
    openStream: () => {
      const stream = new FakeStream()
      streams.push(stream)
      return stream
    },
    read: async (room, id) => {
      reads.push(`${room} ${id}`)
      return (await read(room, id)) as never
    },
    focusTarget: win,
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => { (timer as { cleared: boolean }).cleared = true },
  }))!
  return { followed, streams, reads, win, timers, scope }
}

test('a waiting invite hears the join from the account stream, then stops listening', async () => {
  const { followed, streams, win } = harness()
  followed.follow(invite('inv_1', 'open') as never)
  assert.equal(streams.length, 1, 'one stream while the invite waits')
  assert.equal(win.listeners.size, 1)

  // Frames about other invites, and broken frames, change nothing.
  streams[0]!.fire('room_invite', { invite: invite('inv_other', 'used', 'admitted') })
  streams[0]!.listeners.get('room_invite')![0]!({ data: '{not json' })
  assert.equal(followed.invite.value?.state, 'open')

  streams[0]!.fire('room_invite', { invite: invite('inv_1', 'used', 'admitted') })
  assert.equal(followed.invite.value?.state, 'used')
  assert.equal(followed.invite.value?.outcome, 'admitted')
  assert.equal(streams[0]!.closed, true, 'an ended invite needs no stream')
  assert.equal(win.listeners.size, 0)
})

test('each time the stream opens, the invite is read once, so a join made while it was down is not missed', async () => {
  let answer = invite('inv_2', 'open')
  const { followed, streams, reads } = harness(async () => answer)
  followed.follow(invite('inv_2', 'open') as never)
  streams[0]!.fire('open')
  await settle()
  assert.deepEqual(reads, ['PTGA-21RN-W0QP inv_2'])
  assert.equal(followed.invite.value?.state, 'open')

  // The stream dropped and came back; the bot joined meanwhile.
  answer = invite('inv_2', 'used', 'requested')
  streams[0]!.fire('open')
  await settle()
  assert.equal(reads.length, 2)
  assert.equal(followed.invite.value?.state, 'used')
  assert.equal(followed.invite.value?.outcome, 'requested')
  assert.equal(streams[0]!.closed, true)
})

test('a returning window reads the invite; a failed read keeps it waiting', async () => {
  let fail = true
  const { followed, reads, win } = harness(async () => {
    if (fail) throw new Error('offline')
    return invite('inv_3', 'cancelled')
  })
  followed.follow(invite('inv_3', 'open') as never)
  win.focus()
  await settle()
  assert.equal(followed.invite.value?.state, 'open', 'no answer is not an end')
  fail = false
  win.focus()
  await settle()
  assert.equal(reads.length, 2)
  assert.equal(followed.invite.value?.state, 'cancelled')
})

test('a new invite reuses the stream; stop, an ended invite and the end of the scope close it', async () => {
  const { followed, streams, win, scope } = harness()
  followed.follow(invite('inv_4', 'open') as never)
  followed.follow(invite('inv_5', 'open') as never)
  assert.equal(streams.length, 1)
  // A late answer about the replaced invite is ignored.
  followed.update(invite('inv_4', 'used', 'admitted') as never)
  assert.equal(followed.invite.value?.id, 'inv_5')
  assert.equal(followed.invite.value?.state, 'open')

  followed.stop()
  assert.equal(followed.invite.value, null)
  assert.equal(streams[0]!.closed, true)
  assert.equal(win.listeners.size, 0)

  followed.follow(invite('inv_6', 'used', 'admitted') as never)
  assert.equal(streams.length, 1, 'an invite that already ended opens no stream')

  followed.follow(invite('inv_7', 'open') as never)
  assert.equal(streams.length, 2)
  scope.stop()
  assert.equal(streams[1]!.closed, true, 'leaving the room closes the stream')
})

test('a refused cancel names the invite, so the drawer learns it was used', () => {
  const refusal = Object.assign(new Error('This invite is already used.'), {
    status: 409,
    code: 'INVITE_NOT_OPEN',
    payload: { error: 'This invite is already used.', code: 'INVITE_NOT_OPEN', invite: invite('inv_8', 'used', 'admitted') },
  })
  assert.equal(inviteFromRefusal(refusal)?.state, 'used')
  assert.equal(inviteFromRefusal(new Error('offline')), null)
  assert.equal(inviteFromRefusal(null), null)
})

test('a late read cannot undo a join the stream already brought', async () => {
  let answer!: (value: unknown) => void
  const { followed, streams, win } = harness(() => new Promise((resolve) => { answer = resolve }))
  followed.follow(invite('inv_9', 'open') as never)
  win.focus()
  streams[0]!.fire('room_invite', { invite: invite('inv_9', 'used', 'admitted') })
  assert.equal(followed.invite.value?.state, 'used')
  // The read started before the join was saved, and lands after the frame.
  answer(invite('inv_9', 'open'))
  await settle()
  assert.equal(followed.invite.value?.state, 'used', 'an ended invite never opens again')
})

test('an invite made after the drawer closed starts nothing', () => {
  const { followed, streams, win, scope } = harness()
  scope.stop()
  followed.follow(invite('inv_10', 'open') as never)
  assert.equal(streams.length, 0)
  assert.equal(win.listeners.size, 0)
  assert.equal(followed.invite.value, null)
})

test('a stream the browser gave up on opens again after a growing wait, or at once when the window comes back', async () => {
  const { followed, streams, reads, win, timers } = harness(async () => invite('inv_11', 'open'))
  followed.follow(invite('inv_11', 'open') as never)

  // Reconnecting by itself (still connecting): nothing to do, the next "open" reads.
  streams[0]!.fire('error')
  assert.equal(timers.length, 0)

  // A 502 during a deploy: the browser closes the stream for good.
  streams[0]!.readyState = 2
  streams[0]!.fire('error')
  assert.equal(streams[0]!.closed, true)
  assert.deepEqual(timers.map((timer) => timer.ms), [2_000])
  timers[0]!.run()
  assert.equal(streams.length, 2, 'opened again after the wait')

  streams[1]!.readyState = 2
  streams[1]!.fire('error')
  assert.deepEqual(timers.map((timer) => timer.ms), [2_000, 5_000], 'the next wait is longer')

  // The person comes back to the window: the stream opens now, and its "open" reads the invite.
  win.focus()
  assert.equal(streams.length, 3)
  assert.equal(timers[1]!.cleared, true)
  streams[2]!.fire('open')
  await settle()
  assert.equal(reads.length, 1)

  // A good open resets the waits; an ended invite clears any pending one.
  streams[2]!.readyState = 2
  streams[2]!.fire('error')
  assert.equal(timers.at(-1)!.ms, 2_000)
  followed.update(invite('inv_11', 'used', 'admitted') as never)
  assert.equal(timers.at(-1)!.cleared, true)
  assert.equal(win.listeners.size, 0)
})
