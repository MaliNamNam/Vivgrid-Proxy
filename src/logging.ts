/**
 * Vivgrid Key Rotation Proxy - Logging Utilities
 */

import { VERBOSE_LOGGING } from "./constants"

export function maskKey(key: string): string {
  if (!key) {
    return "(empty)"
  }

  if (key.length <= 12) {
    return `${key.slice(0, 4)}...`
  }

  return `${key.slice(0, 8)}...${key.slice(-4)}`
}

export function sanitizeHeaderValue(name: string, value: string): string {
  const normalized = name.toLowerCase()

  if (normalized === "authorization") {
    if (value.startsWith("Bearer ")) {
      return `Bearer ${maskKey(value.slice(7))}`
    }

    return "(redacted)"
  }

  if (normalized === "x-api-key") {
    return maskKey(value)
  }

  return value
}

export function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, name) => {
    result[name] = sanitizeHeaderValue(name, value)
  })
  return result
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function verboseLog(message: string, details?: unknown) {
  if (!VERBOSE_LOGGING) {
    return
  }

  const timestamp = new Date().toISOString()
  console.log(`  [${timestamp}] ${message}`)

  if (details !== undefined) {
    const serialized = typeof details === "string" ? details : safeStringify(details)
    serialized.split("\n").forEach(line => {
      console.log(`    ${line}`)
    })
  }
}

export function verboseError(message: string, error: unknown, context?: Record<string, unknown>) {
  const timestamp = new Date().toISOString()
  console.error(`  [${timestamp}] ${message}`)

  if (context && Object.keys(context).length > 0) {
    const serialized = safeStringify(context)
    serialized.split("\n").forEach(line => {
      console.error(`    ${line}`)
    })
  }

  if (error instanceof Error) {
    console.error(`    name: ${error.name}`)
    console.error(`    message: ${error.message}`)

    if (error.stack) {
      error.stack.split("\n").forEach(line => {
        console.error(`    ${line}`)
      })
    }

    if ("cause" in error && error.cause) {
      const cause = safeStringify(error.cause)
      cause.split("\n").forEach(line => {
        console.error(`    cause: ${line}`)
      })
    }
  } else {
    const serialized = safeStringify(error)
    serialized.split("\n").forEach(line => {
      console.error(`    non-error value: ${line}`)
    })
  }
}
