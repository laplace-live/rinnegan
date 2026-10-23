import type { Message } from '@laplace.live/event-types'

import type { ChatMessage } from '@/types'

/** The `message` event LAPLACE Event Bridge sends for `message`; `patch` overrides any field, even invalid ones. */
export function messageEvent(
  message: Pick<ChatMessage, 'id' | 'roomId' | 'uid' | 'uname' | 'text' | 'timestamp'>,
  patch: Record<string, unknown> = {}
): Message {
  return {
    type: 'message',
    id: message.id,
    origin: message.roomId,
    originIdx: 0,
    uid: message.uid,
    username: message.uname,
    avatar: '',
    nameColor: '',
    message: message.text,
    userType: 0,
    userLvl: 0,
    userLvlBorder: 0,
    currentRank: 0,
    phoneVerified: 1,
    guardType: 0,
    sendType: 0,
    medal: { level: 0, name: '', room: 0, guardType: 0, lightened: 0, uid: 0, type: 0 },
    reply: {},
    idStr: message.id,
    wealthMedalLevel: 0,
    timestamp: message.timestamp,
    timestampNormalized: message.timestamp,
    read: false,
    ...patch,
  } as Message
}
