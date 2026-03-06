/**
 * Vivgrid Key Rotation Proxy - Proxy Server
 */

import { VIVGRID_BASE_URL } from "./constants"
import { verboseLog, verboseError, maskKey, headersToObject } from "./logging"
import type { Config, Settings, KeyStats } from "./types"

// ============================================
// SSE Buffer Transform
// ============================================

/**
 * Creates a TransformStream that buffers SSE events and ensures
 * complete events are forwarded (prevents mid-event chunk splits).
 * 
 * SSE events are delimited by double newlines (\n\n).
 * This transformer accumulates data until it has complete events,
 * then forwards them to prevent JSON parsing errors from partial data.
 */
function createSSEBufferTransform(requestId: number): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  let chunkCount = 0
  let eventCount = 0
  
  return new TransformStream({
    transform(chunk, controller) {
      chunkCount++

      // Decode the chunk and add to buffer
      buffer += decoder.decode(chunk, { stream: true })
      verboseLog(`SSE request #${requestId} received chunk`, {
        chunkCount,
        chunkBytes: chunk.byteLength,
        bufferedBytes: buffer.length,
      })
      
      // SSE events are separated by double newlines
      // Find and forward complete events
      let eventEnd: number
      while ((eventEnd = buffer.indexOf("\n\n")) !== -1) {
        // Extract complete event including the delimiter
        const completeEvent = buffer.slice(0, eventEnd + 2)
        buffer = buffer.slice(eventEnd + 2)
        
        // Forward the complete event
        controller.enqueue(encoder.encode(completeEvent))
        eventCount++

        verboseLog(`SSE request #${requestId} forwarded complete event`, {
          eventCount,
          eventBytes: completeEvent.length,
          remainingBufferedBytes: buffer.length,
        })
      }
    },
    
    flush(controller) {
      // Forward any remaining data in the buffer
      if (buffer.length > 0) {
        controller.enqueue(encoder.encode(buffer))

        verboseLog(`SSE request #${requestId} flushed trailing buffer`, {
          trailingBytes: buffer.length,
        })
      }

      verboseLog(`SSE request #${requestId} stream closed`, {
        chunkCount,
        eventCount,
      })
    }
  })
}

/**
 * Check if a response is an SSE stream based on content-type header
 */
function isSSEResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") || ""
  return contentType.includes("text/event-stream")
}

const DEFAULT_RATE_LIMIT_WAIT_MS = 1000
const MAX_RATE_LIMIT_WAIT_MS = 30000

interface KeySelection {
  key: string
  index: number
  reason: "balanced" | "sticky-current" | "sticky-fallback" | "sticky-probe"
}

function parseRetryAfterMs(retryAfter?: string) {
  if (!retryAfter) {
    return null
  }

  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.ceil(seconds * 1000))
  }

  const timestamp = Date.parse(retryAfter)
  if (!Number.isNaN(timestamp)) {
    return Math.max(0, timestamp - Date.now())
  }

  return null
}

function createProxyResponse(
  response: Response,
  requestId: number,
  keyIndex: number,
  rotationMode: Settings["rotationMode"]
) {
  const responseHeaders = new Headers(response.headers)
  responseHeaders.set("x-proxy-key-index", String(keyIndex))
  responseHeaders.set("x-proxy-rotation-mode", rotationMode)

  let responseBody = response.body
  if (isSSEResponse(response) && responseBody) {
    verboseLog(`Request #${requestId} response is SSE, enabling event buffer transform`)
    responseBody = responseBody.pipeThrough(createSSEBufferTransform(requestId))
  } else if (isSSEResponse(response)) {
    verboseLog(`Request #${requestId} response marked as SSE but has no body`)
  }

  verboseLog(`Request #${requestId} returning response`, {
    status: response.status,
    statusText: response.statusText,
    proxyHeaders: {
      "x-proxy-key-index": String(keyIndex),
      "x-proxy-rotation-mode": rotationMode,
    },
  })

  return new Response(responseBody, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  })
}

// ============================================
// Proxy Server
// ============================================

export function runProxy(config: Config, settings: Settings) {
  if (config.keys.length === 0) {
    console.log("\n  ⚠ No keys configured. Add keys first.")
    return null
  }
  
  const keys = config.keys.map(k => k.key)
  let currentKeyIndex = 0
  let requestCounter = 0
  const stickyProbeQueue: number[] = []
  
  const keyStats = new Map<string, KeyStats>()
  keys.forEach(key => {
    keyStats.set(key, {
      requests: 0,
      errors: 0,
      lastUsed: 0,
      rateLimited: false,
      rateLimitCount: 0,
    })
  })

  verboseLog("Proxy initialized", {
    port: settings.port,
    rotationMode: settings.rotationMode,
    keyCount: keys.length,
    keys: config.keys.map((entry, index) => ({
      index: index + 1,
      name: entry.name || null,
      prefix: maskKey(entry.key),
    })),
  })

  function removeStickyProbe(index: number) {
    const queueIndex = stickyProbeQueue.indexOf(index)
    if (queueIndex !== -1) {
      stickyProbeQueue.splice(queueIndex, 1)
    }
  }

  function enqueueStickyProbe(index: number) {
    removeStickyProbe(index)
    stickyProbeQueue.push(index)
  }

  function clearExpiredRateLimit(index: number, now: number, context: string) {
    const key = keys[index]
    const stats = keyStats.get(key)!

    if (!stats.rateLimited || !stats.rateLimitResetAt || now < stats.rateLimitResetAt) {
      return false
    }

    stats.rateLimited = false
    stats.rateLimitResetAt = undefined

    verboseLog(context, {
      keyIndex: index + 1,
      key: maskKey(key),
      queuedForProbe: stickyProbeQueue.includes(index),
    })

    return true
  }

  function recordSelection(index: number, now: number) {
    const key = keys[index]
    const stats = keyStats.get(key)!
    stats.requests++
    stats.lastUsed = now
  }

  function getStickyProbeCandidate(now: number, excludedIndices: Set<number>) {
    for (let i = stickyProbeQueue.length - 1; i >= 0; i--) {
      const index = stickyProbeQueue[i]
      if (excludedIndices.has(index)) {
        continue
      }

      clearExpiredRateLimit(index, now, "Sticky probe became eligible again")

      const stats = keyStats.get(keys[index])!
      if (!stats.rateLimited) {
        return index
      }
    }

    return null
  }
  
  function getKeyBalanced(excludedIndices: Set<number>): KeySelection | null {
    const now = Date.now()

    verboseLog("Selecting key using balanced mode", {
      startingIndex: currentKeyIndex + 1,
      excludedIndices: Array.from(excludedIndices, index => index + 1),
    })
    
    // Round-robin: try each key starting from currentKeyIndex
    for (let i = 0; i < keys.length; i++) {
      const candidateIndex = (currentKeyIndex + i) % keys.length
      if (excludedIndices.has(candidateIndex)) {
        continue
      }

      const key = keys[candidateIndex]
      const stats = keyStats.get(key)!

      clearExpiredRateLimit(candidateIndex, now, "Cleared expired rate limit for balanced candidate")

      verboseLog("Balanced candidate", {
        keyIndex: candidateIndex + 1,
        key: maskKey(key),
        rateLimited: stats.rateLimited,
        rateLimitResetAt: stats.rateLimitResetAt ? new Date(stats.rateLimitResetAt).toISOString() : null,
        requests: stats.requests,
        errors: stats.errors,
      })
      
      if (!stats.rateLimited) {
        currentKeyIndex = (currentKeyIndex + i + 1) % keys.length
        recordSelection(candidateIndex, now)

        verboseLog("Balanced key selected", {
          selectedIndex: candidateIndex + 1,
          selectedKey: maskKey(key),
          nextStartIndex: currentKeyIndex + 1,
          totalRequestsForKey: stats.requests,
        })

        return {
          key,
          index: candidateIndex,
          reason: "balanced",
        }
      }
    }

    verboseLog("All keys are cooling down in balanced mode")
    return null
  }
  
  function getKeySticky(excludedIndices: Set<number>): KeySelection | null {
    const now = Date.now()

    const probeIndex = getStickyProbeCandidate(now, excludedIndices)
    if (probeIndex !== null) {
      const key = keys[probeIndex]
      const stats = keyStats.get(key)!

      recordSelection(probeIndex, now)

      verboseLog("Sticky mode probing previously rate-limited key", {
        probeIndex: probeIndex + 1,
        probeKey: maskKey(key),
        totalRequestsForKey: stats.requests,
        probeQueue: stickyProbeQueue.map(index => index + 1),
      })

      return {
        key,
        index: probeIndex,
        reason: "sticky-probe",
      }
    }

    // Check if current key is usable
    const currentKey = keys[currentKeyIndex]
    const currentStats = keyStats.get(currentKey)!

    verboseLog("Selecting key using sticky mode", {
      currentIndex: currentKeyIndex + 1,
      currentKey: maskKey(currentKey),
      currentRateLimited: currentStats.rateLimited,
      currentRateLimitResetAt: currentStats.rateLimitResetAt ? new Date(currentStats.rateLimitResetAt).toISOString() : null,
      excludedIndices: Array.from(excludedIndices, index => index + 1),
      probeQueue: stickyProbeQueue.map(index => index + 1),
    })

    clearExpiredRateLimit(currentKeyIndex, now, "Cleared expired rate limit for current sticky key")
    
    // Use current key if not rate-limited
    if (!excludedIndices.has(currentKeyIndex) && !currentStats.rateLimited) {
      recordSelection(currentKeyIndex, now)

      verboseLog("Sticky mode selected current key", {
        selectedIndex: currentKeyIndex + 1,
        selectedKey: maskKey(currentKey),
        totalRequestsForKey: currentStats.requests,
      })

      return {
        key: currentKey,
        index: currentKeyIndex,
        reason: "sticky-current",
      }
    }
    
    // Current key is rate-limited, find next available key
    for (let i = 1; i < keys.length; i++) {
      const candidateIndex = (currentKeyIndex + i) % keys.length
      if (excludedIndices.has(candidateIndex)) {
        continue
      }

      const key = keys[candidateIndex]
      const stats = keyStats.get(key)!

      clearExpiredRateLimit(candidateIndex, now, "Cleared expired rate limit for fallback key")

      verboseLog("Sticky fallback candidate", {
        keyIndex: candidateIndex + 1,
        key: maskKey(key),
        rateLimited: stats.rateLimited,
        rateLimitResetAt: stats.rateLimitResetAt ? new Date(stats.rateLimitResetAt).toISOString() : null,
      })
      
      if (!stats.rateLimited) {
        currentKeyIndex = candidateIndex
        recordSelection(candidateIndex, now)
        console.log(`  ↻ Switched to key #${currentKeyIndex + 1}`)

        verboseLog("Sticky mode switched to fallback key", {
          selectedIndex: currentKeyIndex + 1,
          selectedKey: maskKey(key),
          totalRequestsForKey: stats.requests,
        })

        return {
          key,
          index: candidateIndex,
          reason: "sticky-fallback",
        }
      }
    }

    verboseLog("All keys are cooling down in sticky mode", {
      probeQueue: stickyProbeQueue.map(index => index + 1),
    })

    return null
  }
  
  function getBestKey(excludedIndices: Set<number>): KeySelection | null {
    verboseLog("Choosing key", {
      rotationMode: settings.rotationMode,
      excludedIndices: Array.from(excludedIndices, index => index + 1),
    })

    if (settings.rotationMode === "sticky") {
      return getKeySticky(excludedIndices)
    } else {
      return getKeyBalanced(excludedIndices)
    }
  }

  function handleRecoveredKey(selection: KeySelection, status: number) {
    const stats = keyStats.get(selection.key)
    if (!stats) {
      return
    }

    const hadRateLimitState = Boolean(
      stats.rateLimited ||
      stats.rateLimitResetAt ||
      stats.rateLimitCount ||
      stickyProbeQueue.includes(selection.index)
    )

    stats.rateLimited = false
    stats.rateLimitResetAt = undefined
    stats.rateLimitCount = 0

    removeStickyProbe(selection.index)

    if (selection.reason === "sticky-probe" && currentKeyIndex !== selection.index) {
      currentKeyIndex = selection.index
      console.log(`  ↻ Restored sticky key #${currentKeyIndex + 1}`)
    }

    if (hadRateLimitState) {
      console.log(`  ✓ Key ${maskKey(selection.key)} recovered`)

      verboseLog("Key recovered from rate limit", {
        keyIndex: selection.index + 1,
        key: maskKey(selection.key),
        status,
        stickyProbeQueue: stickyProbeQueue.map(index => index + 1),
      })
    }
  }

  function getSoonestRateLimitResetMs() {
    const now = Date.now()
    let soonestResetMs = Infinity

    for (const key of keys) {
      const stats = keyStats.get(key)!
      if (!stats.rateLimited || !stats.rateLimitResetAt) {
        continue
      }

      soonestResetMs = Math.min(soonestResetMs, Math.max(stats.rateLimitResetAt - now, 0))
    }

    return Number.isFinite(soonestResetMs) ? soonestResetMs : DEFAULT_RATE_LIMIT_WAIT_MS
  }
  
  function handleRateLimit(index: number, retryAfter?: string) {
    const key = keys[index]
    const stats = keyStats.get(key)
    if (stats) {
      const explicitWaitMs = parseRetryAfterMs(retryAfter)
      const previousRateLimitCount = stats.rateLimitCount || 0
      const waitMs = explicitWaitMs ?? (
        previousRateLimitCount === 0
          ? 0
          : Math.min(DEFAULT_RATE_LIMIT_WAIT_MS * 2 ** (previousRateLimitCount - 1), MAX_RATE_LIMIT_WAIT_MS)
      )
      const now = Date.now()

      stats.rateLimited = true
      stats.errors++
      stats.rateLimitResetAt = now + waitMs
      stats.rateLimitCount = previousRateLimitCount + 1
      stats.lastRateLimitedAt = now

      if (settings.rotationMode === "sticky") {
        enqueueStickyProbe(index)
      }

      if (waitMs === 0) {
        console.log(`  ⚠ Key ${maskKey(key)} rate limited, will probe it again on the next request`)
      } else {
        console.log(`  ⚠ Key ${maskKey(key)} rate limited, retry in ${Math.max(1, Math.ceil(waitMs / 1000))}s`)
      }

      verboseLog("Rate limit recorded", {
        keyIndex: index + 1,
        key: maskKey(key),
        retryAfterHeader: retryAfter || null,
        retryAfterMs: explicitWaitMs,
        waitMs,
        immediateProbe: waitMs === 0,
        rateLimitResetAt: new Date(stats.rateLimitResetAt).toISOString(),
        rateLimitCount: stats.rateLimitCount,
        stickyProbeQueue: stickyProbeQueue.map(queueIndex => queueIndex + 1),
        keyErrors: stats.errors,
      })
    } else {
      verboseLog("Rate limit reported for unknown key", {
        keyIndex: index + 1,
        key: maskKey(key),
        retryAfterHeader: retryAfter || null,
      })
    }
  }

  function createUnavailableResponse(requestId: number) {
    const waitMs = getSoonestRateLimitResetMs()
    const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000))

    console.log(`  ⚠ All keys are cooling down, retry in ${retryAfterSeconds}s`)

    return Response.json(
      {
        error: "Rate limited",
        message: "All configured keys are temporarily rate-limited",
        requestId,
      },
      {
        status: 429,
        headers: {
          "retry-after": String(retryAfterSeconds),
          "x-proxy-key-index": "0",
          "x-proxy-rotation-mode": settings.rotationMode,
        },
      }
    )
  }
  
  const server = Bun.serve({
    port: settings.port,
    idleTimeout: 0,
    
    async fetch(req: Request): Promise<Response> {
      const requestId = ++requestCounter
      const requestStartedAt = Date.now()
      const url = new URL(req.url)

      verboseLog(`Request #${requestId} received`, {
        method: req.method,
        pathname: url.pathname,
        search: url.search,
        fullUrl: req.url,
        hasBody: req.body !== null,
        contentType: req.headers.get("content-type"),
        contentLength: req.headers.get("content-length"),
        headers: headersToObject(req.headers),
      })
      
      if (url.pathname === "/health") {
        const healthResponse = {
          status: "ok",
          keys: keys.length,
          rotationMode: settings.rotationMode,
        }

        verboseLog(`Request #${requestId} handled /health`, healthResponse)
        return Response.json(healthResponse)
      }
      
      if (url.pathname === "/stats") {
        const statsResponse = {
          totalKeys: keys.length,
          rotationMode: settings.rotationMode,
          currentKeyIndex: currentKeyIndex + 1,
          keys: keys.map((key, i) => ({
            index: i + 1,
            prefix: key.slice(0, 8) + "...",
            name: config.keys[i]?.name,
            active: i === currentKeyIndex,
            ...keyStats.get(key)
          }))
        }

        verboseLog(`Request #${requestId} handled /stats`, statsResponse)
        return Response.json(statsResponse)
      }
      
      const targetUrl = `${VIVGRID_BASE_URL}${url.pathname}${url.search}`
      const attemptedIndices = new Set<number>()
      let lastRateLimitedResponse: Response | null = null
      let lastRateLimitedKeyIndex = 0
      let lastAttemptedIndex: number | null = null
      let lastUpstreamHeaders: Headers | null = null
      
      try {
        const requestBody = req.body !== null ? await req.arrayBuffer() : undefined

        while (attemptedIndices.size < keys.length) {
          const selection = getBestKey(attemptedIndices)

          if (!selection) {
            break
          }

          attemptedIndices.add(selection.index)

          const keyIndex = selection.index + 1
          const keyName = config.keys[selection.index]?.name || maskKey(selection.key)

          console.log(`  → ${req.method} ${url.pathname} [Key #${keyIndex}: ${keyName}]`)

          verboseLog(`Request #${requestId} selected key`, {
            keyIndex,
            keyName,
            key: maskKey(selection.key),
            selectionReason: selection.reason,
            attemptedIndices: Array.from(attemptedIndices, index => index + 1),
            targetUrl,
          })

          const headers = new Headers(req.headers)
          headers.set("Authorization", `Bearer ${selection.key}`)
          headers.set("x-api-key", selection.key)
          headers.delete("host")

          lastAttemptedIndex = selection.index
          lastUpstreamHeaders = headers

          verboseLog(`Request #${requestId} forwarding upstream`, {
            method: req.method,
            targetUrl,
            hasBody: req.body !== null,
            headers: headersToObject(headers),
          })

          const response = await fetch(targetUrl, {
            method: req.method,
            headers,
            body: requestBody ? requestBody.slice(0) : undefined,
            // @ts-ignore
            duplex: "half",
            // Disable Bun fetch timeout so long-running requests can complete.
            // Opencode controls provider-level timeout separately.
            timeout: false,
          })

          const durationMs = Date.now() - requestStartedAt

          verboseLog(`Request #${requestId} upstream response`, {
            keyIndex,
            key: maskKey(selection.key),
            selectionReason: selection.reason,
            status: response.status,
            statusText: response.statusText,
            durationMs,
            contentType: response.headers.get("content-type"),
            contentLength: response.headers.get("content-length"),
            headers: headersToObject(response.headers),
          })

          if (response.status === 429) {
            handleRateLimit(selection.index, response.headers.get("retry-after") || undefined)
            lastRateLimitedResponse = response
            lastRateLimitedKeyIndex = keyIndex

            if (attemptedIndices.size < keys.length) {
              console.log(`  ↻ Retrying ${req.method} ${url.pathname} with another key`)

              try {
                await response.body?.cancel()
              } catch {
                // Ignore body cancellation issues on retry.
              }

              continue
            }
          } else {
            handleRecoveredKey(selection, response.status)
          }

          return createProxyResponse(response, requestId, keyIndex, settings.rotationMode)
        }

        if (lastRateLimitedResponse) {
          return createProxyResponse(lastRateLimitedResponse, requestId, lastRateLimitedKeyIndex, settings.rotationMode)
        }

        return createUnavailableResponse(requestId)
      } catch (error) {
        const durationMs = Date.now() - requestStartedAt

        const lastAttemptedKey = lastAttemptedIndex !== null ? keys[lastAttemptedIndex] : null
        if (lastAttemptedKey) {
          const stats = keyStats.get(lastAttemptedKey)
          if (stats) {
            stats.errors++
          }
        }
        
        verboseError(`Request #${requestId} proxy failure`, error, {
          method: req.method,
          pathname: url.pathname,
          search: url.search,
          targetUrl,
          attemptedKeys: Array.from(attemptedIndices, index => maskKey(keys[index])),
          attemptedKeyIndices: Array.from(attemptedIndices, index => index + 1),
          lastAttemptedKeyIndex: lastAttemptedIndex !== null ? lastAttemptedIndex + 1 : null,
          lastAttemptedKey: lastAttemptedKey ? maskKey(lastAttemptedKey) : null,
          durationMs,
          requestHeaders: headersToObject(req.headers),
          upstreamHeaders: lastUpstreamHeaders ? headersToObject(lastUpstreamHeaders) : null,
        })

        return Response.json(
          {
            error: "Proxy error",
            message: error instanceof Error ? error.message : String(error),
            requestId,
          },
          { status: 502 }
        )
      }
    },
  })
  
  return server
}
