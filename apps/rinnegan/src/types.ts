/** A paid event (gift, SuperChat, guard) used by conditional unban rules. */
export interface SpendEvent {
  id: string
  roomId: number
  uid: number
  uname: string
  /** Real currency (CNY) value */
  amount: number
  kind: 'gift' | 'superchat' | 'guard'
  timestamp: number
}
