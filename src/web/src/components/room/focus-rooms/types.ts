import type {
  FocusRoomConclusionDetails,
  FocusRoomInfo,
  FocusRoomSettings,
  RoomTask,
} from '@/composables/useRoom'

export interface FocusRoomsViewProps {
  tasks: readonly RoomTask[]
  focusRooms: readonly FocusRoomInfo[]
  selectedTaskId: string | null
  roomLabel: string
  roomAddress: string
  isFocusRoom: boolean
  sourceTaskId: string | null
  focusKey: string | null
  focusStatus: 'active' | 'concluded' | null
  focusSettings: FocusRoomSettings
  conclusionSummary: string | null
  conclusionDetails: FocusRoomConclusionDetails | null
  isCreatingFocusRoom: boolean
  isCreatingAdHocFocusRoom: boolean
  isSharingFocusResult: boolean
  isUpdatingFocusSettings: boolean
}

export type FocusRoomsViewEmit = {
  (event: 'selectTask', taskId: string): void
  (event: 'createFocusRoom', taskId: string): void
  (event: 'createAdHocFocusRoom', title: string): void
  (event: 'openFocusRoom', focusKey: string): void
  (event: 'openParentRoom'): void
  (event: 'shareResults', summary: string, details: FocusRoomConclusionDetails | null): void
  (event: 'updateFocusSettings', focusKey: string, settings: FocusRoomSettings): void
}

export interface FocusSettingsTarget {
  focusKey: string | null
  settings: FocusRoomSettings
}
