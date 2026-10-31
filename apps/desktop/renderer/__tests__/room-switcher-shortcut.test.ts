import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canOpenRoomSwitcher,
  getRoomSwitcherAriaKeyShortcuts,
  getRoomSwitcherShortcutLabel,
  isMacPlatform,
  isRoomSwitcherShortcut,
  type CanOpenRoomSwitcherOptions,
  type RoomSwitcherShortcutEvent,
} from '../src/domain/room-switcher-shortcut';

describe('room-switcher-shortcut: platform detection and labels', () => {
  it('identifies macOS platforms and returns ⌘ K label and Meta+K ARIA shortcuts', () => {
    for (const macPlatform of ['MacIntel', 'Macintosh', 'MacPPC', 'iPhone', 'iPad', 'macOS']) {
      assert.equal(isMacPlatform(macPlatform), true, `platform ${macPlatform} should be recognized as Mac`);
      assert.equal(getRoomSwitcherShortcutLabel(macPlatform), '⌘ K');
      assert.equal(getRoomSwitcherAriaKeyShortcuts(macPlatform), 'Meta+K');
    }
  });

  it('identifies non-macOS platforms and returns Ctrl K label and Control+K ARIA shortcuts', () => {
    for (const otherPlatform of ['Win32', 'Windows', 'Linux x86_64', 'FreeBSD', '']) {
      assert.equal(isMacPlatform(otherPlatform), false, `platform ${otherPlatform} should be recognized as non-Mac`);
      assert.equal(getRoomSwitcherShortcutLabel(otherPlatform), 'Ctrl K');
      assert.equal(getRoomSwitcherAriaKeyShortcuts(otherPlatform), 'Control+K');
    }
  });
});

describe('room-switcher-shortcut: predicate table test', () => {
  interface TestCase {
    description: string;
    event: RoomSwitcherShortcutEvent;
    platform: string;
    hasOpenModal: boolean;
    isSwitcherOpen: boolean;
    expected: boolean;
  }

  const testCases: TestCase[] = [
    // --- macOS cases ---
    {
      description: 'macOS: Cmd+K with no modal -> opens switcher',
      event: { key: 'k', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
      platform: 'MacIntel',
      hasOpenModal: false,
      isSwitcherOpen: false,
      expected: true,
    },
    {
      description: 'macOS: uppercase K with Cmd -> opens switcher',
      event: { key: 'K', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
      platform: 'MacIntel',
      hasOpenModal: false,
      isSwitcherOpen: false,
      expected: true,
    },
    {
      description: 'macOS: Ctrl+K must NOT open switcher (preserves native Cocoa kill-line in text fields)',
      event: { key: 'k', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      platform: 'MacIntel',
      hasOpenModal: false,
      isSwitcherOpen: false,
      expected: false,
    },
    {
      description: 'macOS: Cmd+Ctrl+K -> rejected',
      event: { key: 'k', metaKey: true, ctrlKey: true, altKey: false, shiftKey: false },
      platform: 'MacIntel',
      hasOpenModal: false,
      isSwitcherOpen: false,
      expected: false,
    },
    {
      description: 'macOS: Cmd+Alt+K -> rejected',
      event: { key: 'k', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false },
      platform: 'MacIntel',
      hasOpenModal: false,
      isSwitcherOpen: false,
      expected: false,
    },
    {
      description: 'macOS: Cmd+Shift+K -> rejected',
      event: { key: 'k', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
      platform: 'MacIntel',
      hasOpenModal: false,
      isSwitcherOpen: false,
      expected: false,
    },

    // --- Windows / Linux cases ---
    {
      description: 'Windows: Ctrl+K with no modal -> opens switcher',
      event: { key: 'k', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      platform: 'Win32',
      hasOpenModal: false,
      isSwitcherOpen: false,
      expected: true,
    },
    {
      description: 'Linux: Ctrl+K with no modal -> opens switcher',
      event: { key: 'k', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      platform: 'Linux x86_64',
      hasOpenModal: false,
      isSwitcherOpen: false,
      expected: true,
    },
    {
      description: 'Windows: Cmd+K -> rejected',
      event: { key: 'k', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
      platform: 'Win32',
      hasOpenModal: false,
      isSwitcherOpen: false,
      expected: false,
    },
    {
      description: 'Windows: Ctrl+Alt+K -> rejected',
      event: { key: 'k', metaKey: false, ctrlKey: true, altKey: true, shiftKey: false },
      platform: 'Win32',
      hasOpenModal: false,
      isSwitcherOpen: false,
      expected: false,
    },
    {
      description: 'Windows: Ctrl+Shift+K -> rejected',
      event: { key: 'k', metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
      platform: 'Win32',
      hasOpenModal: false,
      isSwitcherOpen: false,
      expected: false,
    },

    // --- Common modifier and event guards ---
    {
      description: 'defaultPrevented -> rejected',
      event: { key: 'k', metaKey: true, ctrlKey: false, defaultPrevented: true },
      platform: 'MacIntel',
      hasOpenModal: false,
      isSwitcherOpen: false,
      expected: false,
    },
    {
      description: 'repeat event -> rejected',
      event: { key: 'k', metaKey: true, ctrlKey: false, repeat: true },
      platform: 'MacIntel',
      hasOpenModal: false,
      isSwitcherOpen: false,
      expected: false,
    },
    {
      description: 'IME composition in progress -> rejected',
      event: { key: 'k', metaKey: true, ctrlKey: false, isComposing: true },
      platform: 'MacIntel',
      hasOpenModal: false,
      isSwitcherOpen: false,
      expected: false,
    },
    {
      description: 'different key (e.g. j) -> rejected',
      event: { key: 'j', metaKey: true, ctrlKey: false },
      platform: 'MacIntel',
      hasOpenModal: false,
      isSwitcherOpen: false,
      expected: false,
    },
    {
      description: 'empty key -> rejected',
      event: { key: '', metaKey: true, ctrlKey: false },
      platform: 'MacIntel',
      hasOpenModal: false,
      isSwitcherOpen: false,
      expected: false,
    },

    // --- Modal collision guards ---
    {
      description: 'Another modal dialog is open and switcher is closed -> rejected (never open over existing modal)',
      event: { key: 'k', metaKey: true, ctrlKey: false },
      platform: 'MacIntel',
      hasOpenModal: true,
      isSwitcherOpen: false,
      expected: false,
    },
    {
      description: 'Shortcut triggered while switcher is already open -> true (keeps switcher open, prevents default)',
      event: { key: 'k', metaKey: true, ctrlKey: false },
      platform: 'MacIntel',
      hasOpenModal: true,
      isSwitcherOpen: true,
      expected: true,
    },
    {
      description: 'Shortcut triggered while switcher is already open on Windows -> true',
      event: { key: 'k', metaKey: false, ctrlKey: true },
      platform: 'Win32',
      hasOpenModal: true,
      isSwitcherOpen: true,
      expected: true,
    },
  ];

  for (const { description, event, platform, hasOpenModal, isSwitcherOpen, expected } of testCases) {
    it(description, () => {
      const options: CanOpenRoomSwitcherOptions = {
        event,
        platform,
        hasOpenModal,
        isSwitcherOpen,
      };
      assert.equal(canOpenRoomSwitcher(options), expected);
    });
  }
});

describe('room-switcher-shortcut: lazy evaluation of hasOpenModal', () => {
  it('does NOT evaluate modal check for unrelated keys (e.g. typing in composer)', () => {
    let modalCheckCalls = 0;
    const hasOpenModal = () => {
      modalCheckCalls++;
      return false;
    };

    // Normal typing letters without modifiers
    for (const char of ['a', 'b', 'c', '1', 'Enter', 'Escape', 'Backspace', ' ']) {
      const result = canOpenRoomSwitcher({
        event: { key: char, metaKey: false, ctrlKey: false },
        platform: 'MacIntel',
        hasOpenModal,
        isSwitcherOpen: false,
      });
      assert.equal(result, false);
      assert.equal(modalCheckCalls, 0, `modal check should not run for key: ${char}`);
    }

    // Unrelated letter with Cmd/Ctrl
    const cmdA = canOpenRoomSwitcher({
      event: { key: 'a', metaKey: true, ctrlKey: false },
      platform: 'MacIntel',
      hasOpenModal,
      isSwitcherOpen: false,
    });
    assert.equal(cmdA, false);
    assert.equal(modalCheckCalls, 0, 'modal check should not run for Cmd+A');
  });

  it('does NOT evaluate modal check when modifiers do not match', () => {
    let modalCheckCalls = 0;
    const hasOpenModal = () => {
      modalCheckCalls++;
      return false;
    };

    // Ctrl+K on Mac
    const ctrlKMac = canOpenRoomSwitcher({
      event: { key: 'k', metaKey: false, ctrlKey: true },
      platform: 'MacIntel',
      hasOpenModal,
      isSwitcherOpen: false,
    });
    assert.equal(ctrlKMac, false);
    assert.equal(modalCheckCalls, 0, 'modal check should not run for Ctrl+K on Mac');

    // Cmd+K on Windows
    const cmdKWin = canOpenRoomSwitcher({
      event: { key: 'k', metaKey: true, ctrlKey: false },
      platform: 'Win32',
      hasOpenModal,
      isSwitcherOpen: false,
    });
    assert.equal(cmdKWin, false);
    assert.equal(modalCheckCalls, 0, 'modal check should not run for Cmd+K on Windows');

    // Extra modifiers
    const cmdShiftK = canOpenRoomSwitcher({
      event: { key: 'k', metaKey: true, ctrlKey: false, shiftKey: true },
      platform: 'MacIntel',
      hasOpenModal,
      isSwitcherOpen: false,
    });
    assert.equal(cmdShiftK, false);
    assert.equal(modalCheckCalls, 0, 'modal check should not run with Shift');
  });

  it('does NOT evaluate modal check for repeat, composing, or defaultPrevented events', () => {
    let modalCheckCalls = 0;
    const hasOpenModal = () => {
      modalCheckCalls++;
      return false;
    };

    assert.equal(canOpenRoomSwitcher({
      event: { key: 'k', metaKey: true, ctrlKey: false, repeat: true },
      platform: 'MacIntel',
      hasOpenModal,
      isSwitcherOpen: false,
    }), false);
    assert.equal(modalCheckCalls, 0);

    assert.equal(canOpenRoomSwitcher({
      event: { key: 'k', metaKey: true, ctrlKey: false, isComposing: true },
      platform: 'MacIntel',
      hasOpenModal,
      isSwitcherOpen: false,
    }), false);
    assert.equal(modalCheckCalls, 0);

    assert.equal(canOpenRoomSwitcher({
      event: { key: 'k', metaKey: true, ctrlKey: false, defaultPrevented: true },
      platform: 'MacIntel',
      hasOpenModal,
      isSwitcherOpen: false,
    }), false);
    assert.equal(modalCheckCalls, 0);
  });

  it('does NOT evaluate modal check if the switcher is already open', () => {
    let modalCheckCalls = 0;
    const hasOpenModal = () => {
      modalCheckCalls++;
      return true;
    };

    const result = canOpenRoomSwitcher({
      event: { key: 'k', metaKey: true, ctrlKey: false },
      platform: 'MacIntel',
      hasOpenModal,
      isSwitcherOpen: true,
    });
    assert.equal(result, true);
    assert.equal(modalCheckCalls, 0, 'modal check should not run when switcher is already open');
  });

  it('evaluates modal check exactly once when key and modifiers match and switcher is closed', () => {
    let modalCheckCalls = 0;
    const hasOpenModal = () => {
      modalCheckCalls++;
      return false;
    };

    const result = canOpenRoomSwitcher({
      event: { key: 'k', metaKey: true, ctrlKey: false },
      platform: 'MacIntel',
      hasOpenModal,
      isSwitcherOpen: false,
    });
    assert.equal(result, true);
    assert.equal(modalCheckCalls, 1, 'modal check should run exactly once for valid Cmd+K');
  });
});
