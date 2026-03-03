/**
 * Vivgrid Key Rotation Proxy
 * 
 * Interactive CLI with key management and proxy server
 */

import { readFileSync, writeFileSync, existsSync } from "fs"
import { createInterface } from "readline"

const CONFIG_FILE = "./keys.json"
const SETTINGS_FILE = "./settings.json"
const VIVGRID_BASE_URL = "https://api.vivgrid.com"
const DEFAULT_PORT = 3456

// ============================================
// Key Storage
// ============================================

interface KeyData {
  key: string
  name?: string
  addedAt: number
}

type RotationMode = "sticky" | "balanced"

interface Config {
  keys: KeyData[]
}

interface Settings {
  port: number
  rotationMode: RotationMode
}

function loadConfig(): Config {
  if (existsSync(CONFIG_FILE)) {
    try {
      const data = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))
      return { keys: data.keys || [] }
    } catch {
      return { keys: [] }
    }
  }
  return { keys: [] }
}

function saveConfig(config: Config) {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

function loadSettings(): Settings {
  if (existsSync(SETTINGS_FILE)) {
    try {
      const data = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"))
      return {
        port: data.port || DEFAULT_PORT,
        rotationMode: data.rotationMode || "balanced"
      }
    } catch {
      return { port: DEFAULT_PORT, rotationMode: "balanced" }
    }
  }
  return { port: DEFAULT_PORT, rotationMode: "balanced" }
}

function saveSettings(settings: Settings) {
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
}

function getRotationModeDisplay(mode: RotationMode): string {
  switch (mode) {
    case "sticky":
      return "Sticky (use one key until rate-limited)"
    case "balanced":
      return "Balanced (round-robin rotation)"
  }
}

// ============================================
// Interactive CLI
// ============================================

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
})

function prompt(question: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(question, resolve)
  })
}

function clearScreen() {
  console.clear()
}

function printHeader() {
  console.log(`
╔═══════════════════════════════════════════════╗
║       Vivgrid Key Rotation Proxy              ║
╚═══════════════════════════════════════════════╝
`)
}

function printMenu(config: Config, settings: Settings) {
  printHeader()
  console.log(`  Keys loaded: ${config.keys.length}`)
  console.log(`  Port: ${settings.port}`)
  console.log(`  Rotation: ${getRotationModeDisplay(settings.rotationMode)}`)
  console.log()
  console.log("  1. Run the proxy")
  console.log("  2. Add keys")
  console.log("  3. Remove keys")
  console.log("  4. List keys")
  console.log("  5. Change port")
  console.log("  6. Change rotation mode")
  console.log()
  console.log("  q. Quit")
  console.log()
}

// Check if input is back or quit command
function isBack(input: string): boolean {
  return input.toLowerCase() === "b" || input.toLowerCase() === "back"
}

function isQuit(input: string): boolean {
  return input.toLowerCase() === "q" || input.toLowerCase() === "quit"
}

function handleQuit() {
  clearScreen()
  console.log("\n  Goodbye!\n")
  rl.close()
  process.exit(0)
}

async function addKeys(config: Config): Promise<Config> {
  clearScreen()
  printHeader()
  console.log("  Add API Keys")
  console.log("  ─────────────────────────────────")
  console.log("  Enter keys one per line.")
  console.log("  Type 'done' when finished.")
  console.log("  (b = back, q = quit)")
  console.log()

  let added = 0
  while (true) {
    const input = await prompt("  Key: ")
    
    if (isQuit(input)) {
      handleQuit()
    }
    
    if (isBack(input) || input.toLowerCase() === "done") {
      break
    }
    
    if (input.trim()) {
      // Check if key already exists
      if (config.keys.some(k => k.key === input.trim())) {
        console.log("  ⚠ Key already exists, skipping")
        continue
      }
      
      const name = await prompt("  Name (optional, b = skip): ")
      
      if (isQuit(name)) {
        handleQuit()
      }
      
      config.keys.push({
        key: input.trim(),
        name: (isBack(name) || !name.trim()) ? undefined : name.trim(),
        addedAt: Date.now(),
      })
      added++
      console.log(`  ✓ Key added (${added} new)`)
    }
  }
  
  if (added > 0) {
    saveConfig(config)
    console.log(`\n  Saved ${added} new key(s)`)
    await prompt("\n  Press Enter to continue...")
  }
  
  return config
}

async function removeKeys(config: Config): Promise<Config> {
  clearScreen()
  printHeader()
  
  if (config.keys.length === 0) {
    console.log("  No keys to remove.")
    await prompt("\n  Press Enter to continue (b = back, q = quit)...")
    return config
  }
  
  console.log("  Remove API Keys")
  console.log("  ─────────────────────────────────")
  console.log()
  
  config.keys.forEach((k, i) => {
    const prefix = k.key.slice(0, 12) + "..."
    const name = k.name ? ` (${k.name})` : ""
    console.log(`  ${i + 1}. ${prefix}${name}`)
  })
  
  console.log()
  console.log("  Enter numbers to remove (comma-separated)")
  console.log("  Or 'all' to remove all")
  console.log("  (b = back, q = quit)")
  console.log()
  
  const input = await prompt("  Remove: ")
  
  if (isQuit(input)) {
    handleQuit()
  }
  
  if (isBack(input)) {
    return config
  }
  
  if (input.toLowerCase() === "all") {
    const confirm = await prompt("  Are you sure? (yes/no): ")
    if (isQuit(confirm)) {
      handleQuit()
    }
    if (confirm.toLowerCase() === "yes") {
      config.keys = []
      saveConfig(config)
      console.log("  ✓ All keys removed")
    }
  } else {
    const indices = input.split(",")
      .map(s => parseInt(s.trim()) - 1)
      .filter(i => i >= 0 && i < config.keys.length)
      .sort((a, b) => b - a) // Remove from end first
    
    if (indices.length > 0) {
      for (const idx of indices) {
        config.keys.splice(idx, 1)
      }
      saveConfig(config)
      console.log(`  ✓ Removed ${indices.length} key(s)`)
    }
  }
  
  await prompt("\n  Press Enter to continue...")
  return config
}

async function listKeys(config: Config) {
  clearScreen()
  printHeader()
  console.log("  API Keys")
  console.log("  ─────────────────────────────────")
  console.log()
  
  if (config.keys.length === 0) {
    console.log("  No keys configured.")
  } else {
    config.keys.forEach((k, i) => {
      const prefix = k.key.slice(0, 16) + "..." + k.key.slice(-4)
      const name = k.name ? ` (${k.name})` : ""
      const date = new Date(k.addedAt).toLocaleDateString()
      console.log(`  ${i + 1}. ${prefix}${name}`)
      console.log(`     Added: ${date}`)
    })
  }
  
  console.log()
  console.log("  (b = back, q = quit)")
  const input = await prompt("\n  Press Enter to continue...")
  
  if (isQuit(input)) {
    handleQuit()
  }
}

async function changePort(settings: Settings): Promise<Settings> {
  clearScreen()
  printHeader()
  console.log(`  Current port: ${settings.port}`)
  console.log("  (b = back, q = quit)")
  console.log()
  
  const input = await prompt("  New port: ")
  
  if (isQuit(input)) {
    handleQuit()
  }
  
  if (isBack(input) || !input.trim()) {
    return settings
  }
  
  const port = parseInt(input.trim())
  if (port > 0 && port < 65536) {
    settings.port = port
    saveSettings(settings)
    console.log(`  ✓ Port changed to ${port}`)
  } else {
    console.log("  ⚠ Invalid port number")
  }
  
  await prompt("\n  Press Enter to continue...")
  return settings
}

async function changeRotationMode(settings: Settings): Promise<Settings> {
  clearScreen()
  printHeader()
  console.log("  Change Rotation Mode")
  console.log("  ─────────────────────────────────")
  console.log()
  console.log(`  Current: ${getRotationModeDisplay(settings.rotationMode)}`)
  console.log()
  console.log("  1. Sticky")
  console.log("     Use one key until it hits rate limit, then switch")
  console.log()
  console.log("  2. Balanced")
  console.log("     Round-robin rotation on every request")
  console.log()
  console.log("  (b = back, q = quit)")
  console.log()
  
  const input = await prompt("  Select mode: ")
  
  if (isQuit(input)) {
    handleQuit()
  }
  
  if (isBack(input)) {
    return settings
  }
  
  switch (input.trim()) {
    case "1":
      settings.rotationMode = "sticky"
      saveSettings(settings)
      console.log("  ✓ Rotation mode changed to Sticky")
      break
    case "2":
      settings.rotationMode = "balanced"
      saveSettings(settings)
      console.log("  ✓ Rotation mode changed to Balanced")
      break
    default:
      console.log("  ⚠ Invalid option")
  }
  
  await prompt("\n  Press Enter to continue...")
  return settings
}

// ============================================
// Proxy Server
// ============================================

interface KeyStats {
  requests: number
  errors: number
  lastUsed: number
  rateLimited: boolean
  rateLimitResetAt?: number
}

function runProxy(config: Config, settings: Settings) {
  if (config.keys.length === 0) {
    console.log("\n  ⚠ No keys configured. Add keys first.")
    return null
  }
  
  const keys = config.keys.map(k => k.key)
  let currentKeyIndex = 0
  
  const keyStats = new Map<string, KeyStats>()
  keys.forEach(key => {
    keyStats.set(key, {
      requests: 0,
      errors: 0,
      lastUsed: 0,
      rateLimited: false,
    })
  })
  
  function getKeyBalanced(): string {
    const now = Date.now()
    
    // Round-robin: try each key starting from currentKeyIndex
    for (let i = 0; i < keys.length; i++) {
      const key = keys[(currentKeyIndex + i) % keys.length]
      const stats = keyStats.get(key)!
      
      // Clear rate limit if reset time has passed
      if (stats.rateLimited && stats.rateLimitResetAt && now > stats.rateLimitResetAt) {
        stats.rateLimited = false
      }
      
      if (!stats.rateLimited) {
        currentKeyIndex = (currentKeyIndex + i + 1) % keys.length
        stats.requests++
        stats.lastUsed = now
        return key
      }
    }
    
    // All keys rate-limited, pick the one with earliest reset
    return getKeyWithEarliestReset()
  }
  
  function getKeySticky(): string {
    const now = Date.now()
    
    // Check if current key is usable
    const currentKey = keys[currentKeyIndex]
    const currentStats = keyStats.get(currentKey)!
    
    // Clear rate limit if reset time has passed
    if (currentStats.rateLimited && currentStats.rateLimitResetAt && now > currentStats.rateLimitResetAt) {
      currentStats.rateLimited = false
    }
    
    // Use current key if not rate-limited
    if (!currentStats.rateLimited) {
      currentStats.requests++
      currentStats.lastUsed = now
      return currentKey
    }
    
    // Current key is rate-limited, find next available key
    for (let i = 1; i < keys.length; i++) {
      const key = keys[(currentKeyIndex + i) % keys.length]
      const stats = keyStats.get(key)!
      
      if (stats.rateLimited && stats.rateLimitResetAt && now > stats.rateLimitResetAt) {
        stats.rateLimited = false
      }
      
      if (!stats.rateLimited) {
        currentKeyIndex = (currentKeyIndex + i) % keys.length
        stats.requests++
        stats.lastUsed = now
        console.log(`  ↻ Switched to key #${currentKeyIndex + 1}`)
        return key
      }
    }
    
    // All keys rate-limited
    return getKeyWithEarliestReset()
  }
  
  function getKeyWithEarliestReset(): string {
    let bestKey = keys[0]
    let earliestReset = Infinity
    
    for (const key of keys) {
      const stats = keyStats.get(key)!
      if (stats.rateLimitResetAt && stats.rateLimitResetAt < earliestReset) {
        earliestReset = stats.rateLimitResetAt
        bestKey = key
      }
    }
    
    const stats = keyStats.get(bestKey)!
    stats.requests++
    stats.lastUsed = Date.now()
    return bestKey
  }
  
  function getBestKey(): string {
    if (settings.rotationMode === "sticky") {
      return getKeySticky()
    } else {
      return getKeyBalanced()
    }
  }
  
  function handleRateLimit(key: string, retryAfter?: string) {
    const stats = keyStats.get(key)
    if (stats) {
      stats.rateLimited = true
      stats.errors++
      const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 60000
      stats.rateLimitResetAt = Date.now() + waitMs
      console.log(`  ⚠ Key ${key.slice(0, 8)}... rate limited, reset in ${waitMs / 1000}s`)
    }
  }
  
  const server = Bun.serve({
    port: settings.port,
    
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)
      
      if (url.pathname === "/health") {
        return Response.json({
          status: "ok",
          keys: keys.length,
          rotationMode: settings.rotationMode,
        })
      }
      
      if (url.pathname === "/stats") {
        return Response.json({
          totalKeys: keys.length,
          rotationMode: settings.rotationMode,
          currentKeyIndex: currentKeyIndex + 1,
          keys: keys.map((key, i) => ({
            index: i + 1,
            prefix: key.slice(0, 8) + "...",
            name: config.keys[i].name,
            active: i === currentKeyIndex,
            ...keyStats.get(key)
          }))
        })
      }
      
      const targetUrl = `${VIVGRID_BASE_URL}${url.pathname}${url.search}`
      const apiKey = getBestKey()
      
      const keyIndex = keys.indexOf(apiKey) + 1
      const keyName = config.keys[keyIndex - 1]?.name || apiKey.slice(0, 8) + "..."
      console.log(`  → ${req.method} ${url.pathname} [Key #${keyIndex}: ${keyName}]`)
      
      const headers = new Headers(req.headers)
      headers.set("Authorization", `Bearer ${apiKey}`)
      headers.set("x-api-key", apiKey)
      headers.delete("host")
      
      try {
        const response = await fetch(targetUrl, {
          method: req.method,
          headers,
          body: req.body,
          // @ts-ignore
          duplex: "half",
        })
        
        if (response.status === 429) {
          handleRateLimit(apiKey, response.headers.get("retry-after") || undefined)
        }
        
        const responseHeaders = new Headers(response.headers)
        responseHeaders.set("x-proxy-key-index", String(keyIndex))
        responseHeaders.set("x-proxy-rotation-mode", settings.rotationMode)
        
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        })
      } catch (error) {
        const stats = keyStats.get(apiKey)
        if (stats) stats.errors++
        
        console.error(`  ✗ Error:`, error)
        return Response.json(
          { error: "Proxy error", message: String(error) },
          { status: 502 }
        )
      }
    },
  })
  
  return server
}

// ============================================
// Main Loop
// ============================================

async function main() {
  let config = loadConfig()
  let settings = loadSettings()
  
  while (true) {
    clearScreen()
    printMenu(config, settings)
    
    const choice = await prompt("  Select option: ")
    
    if (isQuit(choice)) {
      handleQuit()
    }
    
    switch (choice.trim()) {
      case "1": {
        // Run proxy
        clearScreen()
        printHeader()
        
        if (config.keys.length === 0) {
          console.log("  ⚠ No keys configured. Add keys first.")
          await prompt("\n  Press Enter to continue (b = back, q = quit)...")
          break
        }
        
        const server = runProxy(config, settings)
        if (server) {
          console.log(`
  ✓ Proxy running!
  ─────────────────────────────────
  URL:      http://localhost:${server.port}
  Keys:     ${config.keys.length}
  Mode:     ${getRotationModeDisplay(settings.rotationMode)}
  Target:   ${VIVGRID_BASE_URL}
  
  Endpoints:
    /v1/*    → Vivgrid API (with key rotation)
    /health  → Health check
    /stats   → Key usage statistics
  
  Update your opencode.json:
  {
    "provider": {
      "vivgrid-anth": {
        "options": {
          "baseURL": "http://localhost:${server.port}/v1"
        }
      }
    }
  }
  
  Press Ctrl+C to stop (or q to quit)
  ─────────────────────────────────
`)
          // Keep running until Ctrl+C
          await new Promise(() => {})
        }
        break
      }
      
      case "2":
        config = await addKeys(config)
        break
        
      case "3":
        config = await removeKeys(config)
        break
        
      case "4":
        await listKeys(config)
        break
        
      case "5":
        settings = await changePort(settings)
        break
        
      case "6":
        settings = await changeRotationMode(settings)
        break
        
      default:
        // Invalid option, just refresh menu
        break
    }
  }
}

main().catch(console.error)
