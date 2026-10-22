export type { BilibiliClientOptions, FetchLike, SilentUserPage } from '@/bilibili/client'
export type { CredentialProviderOptions, CredentialSummary, LoadCredentialsOptions } from '@/bilibili/credentials'
export type { ApiResult, BilibiliCredentials, NavInfo, RoomInfo, SilentUser } from '@/bilibili/types'

export {
  BAD_RESPONSE,
  BilibiliApiError,
  BilibiliClient,
  DEFAULT_USER_AGENT,
  describeResult,
  isAlreadyBanned,
  isAuthFailure,
  isNotBanned,
  NETWORK_ERROR,
  NO_CREDENTIALS,
  normalizeReason,
} from '@/bilibili/client'
export { CredentialProvider, credentialSummary, credentialsFromPayload, loadCredentials } from '@/bilibili/credentials'
