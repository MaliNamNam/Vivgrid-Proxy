/**
 * Vivgrid Key Rotation Proxy - Type Definitions
 */

export interface KeyData {
  key: string
  name?: string
  addedAt: number
}

export type RotationMode = "sticky" | "balanced"

export interface Config {
  keys: KeyData[]
}

export interface Settings {
  port: number
  rotationMode: RotationMode
}

export interface KeyStats {
  requests: number
  errors: number
  lastUsed: number
  rateLimited: boolean
  rateLimitResetAt?: number
}
