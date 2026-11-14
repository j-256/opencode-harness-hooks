import type { DispatchResult } from './engine.js'
import type { BackgroundAnchor } from './background-records.js'
import type { HostPromptEvent } from './prompt-types.js'
import type { SessionSnapshot } from './sessions.js'
import type { NativeEvent } from './types.js'

export interface HostNotificationEvent extends HostPromptEvent { readonly notificationID: string; readonly anchor: BackgroundAnchor }
export interface NotificationContext { readonly dialectData: NonNullable<NativeEvent['dialectData']>; readonly nativeSessionIDs?: NonNullable<NativeEvent['nativeSessionIDs']> }
export interface NotificationServices {
  readonly prepare: (event: HostNotificationEvent, session: SessionSnapshot, signal: AbortSignal) => Promise<NotificationContext>
  readonly capture: (event: HostNotificationEvent, session: SessionSnapshot, dispatch: DispatchResult, signal: AbortSignal) => Promise<void>
}
