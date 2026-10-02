import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decideMessageRevealAction,
  type MessageRevealDecisionInput,
  type MessageRevealAction,
} from '../src/components/room/messageReveal'

test('decideMessageRevealAction table test', () => {
  interface TestCase extends MessageRevealDecisionInput {
    description: string
    expected: MessageRevealAction
  }

  const table: TestCase[] = [
    // 1. Found: immediately scrolls regardless of other states
    {
      description: 'found in DOM: scrolls immediately when history is ready and idle',
      found: true,
      historyReady: true,
      hasOlder: true,
      loading: false,
      pagesRequested: 0,
      expected: 'scroll',
    },
    {
      description: 'found in DOM: scrolls even if history was marked not ready',
      found: true,
      historyReady: false,
      hasOlder: false,
      loading: false,
      pagesRequested: 0,
      expected: 'scroll',
    },
    {
      description: 'found in DOM: scrolls even if a background load is flagged',
      found: true,
      historyReady: true,
      hasOlder: true,
      loading: true,
      pagesRequested: 2,
      expected: 'scroll',
    },

    // 2. Asked before history is ready: must wait
    {
      description: 'asked before history is ready (initial stream connect, bootstrap in flight)',
      found: false,
      historyReady: false,
      hasOlder: false,
      loading: false,
      pagesRequested: 0,
      expected: 'wait',
    },
    {
      description: 'asked before history is ready even if hasOlder is true',
      found: false,
      historyReady: false,
      hasOlder: true,
      loading: false,
      pagesRequested: 0,
      expected: 'wait',
    },
    {
      description: 'asked before history is ready and load is in flight',
      found: false,
      historyReady: false,
      hasOlder: true,
      loading: true,
      pagesRequested: 1,
      expected: 'wait',
    },

    // 3. Asked while a page is loading: must wait (never emit unavailable or too_far_back!)
    {
      description: 'asked while a page is loading (initial page request in flight)',
      found: false,
      historyReady: true,
      hasOlder: true,
      loading: true,
      pagesRequested: 0,
      expected: 'wait',
    },
    {
      description: 'asked while an older page load is in flight (page 1)',
      found: false,
      historyReady: true,
      hasOlder: true,
      loading: true,
      pagesRequested: 1,
      expected: 'wait',
    },
    {
      description: 'asked while older page is loading even if hasOlder is currently false',
      found: false,
      historyReady: true,
      hasOlder: false,
      loading: true,
      pagesRequested: 1,
      expected: 'wait',
    },
    {
      description: 'asked while page is loading at the 20-page limit (must wait for result)',
      found: false,
      historyReady: true,
      hasOlder: true,
      loading: true,
      pagesRequested: 20,
      expected: 'wait',
    },

    // 4. Paging: history ready, idle, has older, pagesRequested < maxPages
    {
      description: 'first older page requested when not found in initial history',
      found: false,
      historyReady: true,
      hasOlder: true,
      loading: false,
      pagesRequested: 0,
      expected: 'load_older',
    },
    {
      description: 'subsequent older page requested (page 1 of 20)',
      found: false,
      historyReady: true,
      hasOlder: true,
      loading: false,
      pagesRequested: 1,
      expected: 'load_older',
    },
    {
      description: 'last allowable page requested (page 19 of 20)',
      found: false,
      historyReady: true,
      hasOlder: true,
      loading: false,
      pagesRequested: 19,
      expected: 'load_older',
    },

    // 5. Too far back: history ready, idle, has older, pagesRequested >= maxPages
    {
      description: 'too far back: 20 pages reached and older messages still remain',
      found: false,
      historyReady: true,
      hasOlder: true,
      loading: false,
      pagesRequested: 20,
      expected: 'too_far_back',
    },
    {
      description: 'too far back: past 20 pages and older messages still remain',
      found: false,
      historyReady: true,
      hasOlder: true,
      loading: false,
      pagesRequested: 25,
      expected: 'too_far_back',
    },

    // 6. Unavailable: history ready, idle, NO older messages remain
    {
      description: 'unavailable: history exhausted on initial page (no older messages)',
      found: false,
      historyReady: true,
      hasOlder: false,
      loading: false,
      pagesRequested: 0,
      expected: 'unavailable',
    },
    {
      description: 'unavailable: history exhausted after loading several older pages',
      found: false,
      historyReady: true,
      hasOlder: false,
      loading: false,
      pagesRequested: 3,
      expected: 'unavailable',
    },

    // 7. Custom maxPages bound
    {
      description: 'custom maxPages bound: load older before limit',
      found: false,
      historyReady: true,
      hasOlder: true,
      loading: false,
      pagesRequested: 4,
      maxPages: 5,
      expected: 'load_older',
    },
    {
      description: 'custom maxPages bound: too far back at limit',
      found: false,
      historyReady: true,
      hasOlder: true,
      loading: false,
      pagesRequested: 5,
      maxPages: 5,
      expected: 'too_far_back',
    },
  ]

  for (const row of table) {
    const actual = decideMessageRevealAction(row)
    assert.equal(actual, row.expected, `Failed for case: ${row.description}`)
  }
})
