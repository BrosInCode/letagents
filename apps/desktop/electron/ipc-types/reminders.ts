export interface DesktopMessageReminder {
  id: string; room_id: string; message_id: string; due_at: string; state: "pending" | "due";
  preview?: { sender: string; snippet: string; room_display_name: string; thread_root_id: string | null } | null;
}
export interface DesktopMessageRemindersPage { reminders: DesktopMessageReminder[]; next_offset: number | null }
