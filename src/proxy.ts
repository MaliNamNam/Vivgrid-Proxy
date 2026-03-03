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
  
  const keyStats = new Map<string, KeyStats>()
  keys.forEach(key => {
    keyStats.set(key, {
      requests: 0,
      errors: 0,
      lastUsed: 0,
      rateLimited: false,
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
  
  function getKeyBalanced(): string {
    const now = Date.now()

    verboseLog("Selecting key using balanced mode", {
      startingIndex: currentKeyIndex + 1,
    })
    
    // Round-robin: try each key starting from currentKeyIndex
    for (let i = 0; i < keys.length; i++) {
      const candidateIndex = (currentKeyIndex + i) % keys.length
      const key = keys[candidateIndex]
      const stats = keyStats.get(key)!

      verboseLog("Balanced candidate", {
        keyIndex: candidateIndex + 1,
        key: maskKey(key),
        rateLimited: stats.rateLimited,
        rateLimitResetAt: stats.rateLimitResetAt ? new Date(stats.rateLimitResetAt).toISOString() : null,
        requests: stats.requests,
        errors: stats.errors,
      })
      
      // Clear rate limit if reset time has passed
      if (stats.rateLimited && stats.rateLimitResetAt && now > stats.rateLimitResetAt) {
        stats.rateLimited = false

        verboseLog("Cleared expired rate limit for key", {
          keyIndex: candidateIndex + 1,
          key: maskKey(key),
        })
      }
      
      if (!stats.rateLimited) {
        currentKeyIndex = (currentKeyIndex + i + 1) % keys.length
        stats.requests++
        stats.lastUsed = now

        verboseLog("Balanced key selected", {
          selectedIndex: candidateIndex + 1,
          selectedKey: maskKey(key),
          nextStartIndex: currentKeyIndex + 1,
          totalRequestsForKey: stats.requests,
        })

        return key
      }
    }
    
    // All keys rate-limited, pick the one with earliest reset
    verboseLog("All keys are rate-limited in balanced mode; selecting earliest reset key")
    return getKeyWithEarliestReset()
  }
  
  function getKeySticky(): string {
    const now = Date.now()
    
    // Check if current key is usable
    const currentKey = keys[currentKeyIndex]
    const currentStats = keyStats.get(currentKey)!

    verboseLog("Selecting key using sticky mode", {
      currentIndex: currentKeyIndex + 1,
      currentKey: maskKey(currentKey),
      currentRateLimited: currentStats.rateLimited,
      currentRateLimitResetAt: currentStats.rateLimitResetAt ? new Date(currentStats.rateLimitResetAt).toISOString() : null,
    })
    
    // Clear rate limit if reset time has passed
    if (currentStats.rateLimited && currentStats.rateLimitResetAt && now > currentStats.rateLimitResetAt) {
      currentStats.rateLimited = false

      verboseLog("Cleared expired rate limit for current sticky key", {
        keyIndex: currentKeyIndex + 1,
        key: maskKey(currentKey),
      })
    }
    
    // Use current key if not rate-limited
    if (!currentStats.rateLimited) {
      currentStats.requests++
      currentStats.lastUsed = now

      verboseLog("Sticky mode selected current key", {
        selectedIndex: currentKeyIndex + 1,
        selectedKey: maskKey(currentKey),
        totalRequestsForKey: currentStats.requests,
      })

      return currentKey
    }
    
    // Current key is rate-limited, find next available key
    for (let i = 1; i < keys.length; i++) {
      const candidateIndex = (currentKeyIndex + i) % keys.length
      const key = keys[candidateIndex]
      const stats = keyStats.get(key)!

      verboseLog("Sticky fallback candidate", {
        keyIndex: candidateIndex + 1,
        key: maskKey(key),
        rateLimited: stats.rateLimited,
        rateLimitResetAt: stats.rateLimitResetAt ? new Date(stats.rateLimitResetAt).toISOString() : null,
      })
      
      if (stats.rateLimited && stats.rateLimitResetAt && now > stats.rateLimitResetAt) {
        stats.rateLimited = false

        verboseLog("Cleared expired rate limit for fallback key", {
          keyIndex: candidateIndex + 1,
          key: maskKey(key),
        })
      }
      
      if (!stats.rateLimited) {
        currentKeyIndex = candidateIndex
        stats.requests++
        stats.lastUsed = now
        console.log(`  ↻ Switched to key #${currentKeyIndex + 1}`)

        verboseLog("Sticky mode switched to fallback key", {
          selectedIndex: currentKeyIndex + 1,
          selectedKey: maskKey(key),
          totalRequestsForKey: stats.requests,
        })

        return key
      }
    }
    
    // All keys rate-limited
    verboseLog("All keys are rate-limited in sticky mode; selecting earliest reset key")
    return getKeyWithEarliestReset()
  }
  
  function getKeyWithEarliestReset(): string {
    let bestKey = keys[0]
    let earliestReset = Infinity
    
    for (const [index, key] of keys.entries()) {
      const stats = keyStats.get(key)!

      verboseLog("Earliest-reset candidate", {
        keyIndex: index + 1,
        key: maskKey(key),
        rateLimited: stats.rateLimited,
        rateLimitResetAt: stats.rateLimitResetAt ? new Date(stats.rateLimitResetAt).toISOString() : null,
      })

      if (stats.rateLimitResetAt && stats.rateLimitResetAt < earliestReset) {
        earliestReset = stats.rateLimitResetAt
        bestKey = key
      }
    }
    
    const stats = keyStats.get(bestKey)!
    stats.requests++
    stats.lastUsed = Date.now()

    verboseLog("Earliest-reset key selected", {
      selectedIndex: keys.indexOf(bestKey) + 1,
      selectedKey: maskKey(bestKey),
      earliestResetAt: Number.isFinite(earliestReset) ? new Date(earliestReset).toISOString() : null,
      totalRequestsForKey: stats.requests,
    })

    return bestKey
  }
  
  function getBestKey(): string {
    verboseLog("Choosing key", {
      rotationMode: settings.rotationMode,
    })

    if (settings.rotationMode === "sticky") {
      return getKeySticky()
    } else {
      return getKeyBalanced()
    }
  }
  
  function handleRateLimit(key: string, retryAfter?: string) {
    const stats = keyStats.get(key)
    if (stats) {
      const retryAfterSeconds = retryAfter ? Number.parseInt(retryAfter, 10) : Number.NaN
      const waitMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 60000

      stats.rateLimited = true
      stats.errors++
      stats.rateLimitResetAt = Date.now() + waitMs

      console.log(`  ⚠ Key ${maskKey(key)} rate limited, reset in ${Math.round(waitMs / 1000)}s`)

      verboseLog("Rate limit recorded", {
        key: maskKey(key),
        retryAfterHeader: retryAfter || null,
        retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
        waitMs,
        rateLimitResetAt: new Date(stats.rateLimitResetAt).toISOString(),
        keyErrors: stats.errors,
      })
    } else {
      verboseLog("Rate limit reported for unknown key", {
        key: maskKey(key),
        retryAfterHeader: retryAfter || null,
      })
    }
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
      const apiKey = getBestKey()
      
      const keyIndex = keys.indexOf(apiKey) + 1
      const keyName = config.keys[keyIndex - 1]?.name || maskKey(apiKey)
      console.log(`  → ${req.method} ${url.pathname} [Key #${keyIndex}: ${keyName}]`)

      verboseLog(`Request #${requestId} selected key`, {
        keyIndex,
        keyName,
        key: maskKey(apiKey),
        targetUrl,
      })
      
      const headers = new Headers(req.headers)
      headers.set("Authorization", `Bearer ${apiKey}`)
      headers.set("x-api-key", apiKey)
      headers.delete("host")

      verboseLog(`Request #${requestId} forwarding upstream`, {
        method: req.method,
        targetUrl,
        hasBody: req.body !== null,
        headers: headersToObject(headers),
      })
      
      try {
        const response = await fetch(targetUrl, {
          method: req.method,
          headers,
          body: req.body,
          // @ts-ignore
          duplex: "half",
          // Disable Bun fetch timeout so long-running requests can complete.
          // Opencode controls provider-level timeout separately.
          timeout: false,
        })

        const durationMs = Date.now() - requestStartedAt

        verboseLog(`Request #${requestId} upstream response`, {
          status: response.status,
          statusText: response.statusText,
          durationMs,
          contentType: response.headers.get("content-type"),
          contentLength: response.headers.get("content-length"),
          headers: headersToObject(response.headers),
        })
        
        if (response.status === 429) {
          handleRateLimit(apiKey, response.headers.get("retry-after") || undefined)
        }
        
        const responseHeaders = new Headers(response.headers)
        responseHeaders.set("x-proxy-key-index", String(keyIndex))
        responseHeaders.set("x-proxy-rotation-mode", settings.rotationMode)
        
        // For SSE streams, buffer events to prevent mid-event chunk splits
        // which can cause JSON parsing errors in clients
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
            "x-proxy-rotation-mode": settings.rotationMode,
          },
        })
        
        return new Response(responseBody, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        })
      } catch (error) {
        const durationMs = Date.now() - requestStartedAt
        const stats = keyStats.get(apiKey)
        if (stats) {
          stats.errors++
        }
        
        verboseError(`Request #${requestId} proxy failure`, error, {
          method: req.method,
          pathname: url.pathname,
          search: url.search,
          targetUrl,
          keyIndex,
          keyName,
          key: maskKey(apiKey),
          durationMs,
          requestHeaders: headersToObject(req.headers),
          upstreamHeaders: headersToObject(headers),
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
