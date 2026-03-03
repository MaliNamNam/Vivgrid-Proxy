/**
 * Vivgrid Key Rotation Proxy - Interactive CLI
 */

import { createInterface } from "readline"
import { saveConfig, saveSettings, getRotationModeDisplay } from "./config"
import type { Config, Settings } from "./types"

// ============================================
// Readline Interface
// ============================================

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
})

export function prompt(question: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(question, resolve)
  })
}

export function closeReadline() {
  rl.close()
}

// ============================================
// Screen Utilities
// ============================================

export function clearScreen() {
  console.clear()
}

export function printHeader() {
  console.log(`
╔═══════════════════════════════════════════════╗
║       Vivgrid Key Rotation Proxy              ║
╚═══════════════════════════════════════════════╝
`)
}

export function printMenu(config: Config, settings: Settings) {
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

// ============================================
// Input Helpers
// ============================================

export function isBack(input: string): boolean {
  return input.toLowerCase() === "b" || input.toLowerCase() === "back"
}

export function isQuit(input: string): boolean {
  return input.toLowerCase() === "q" || input.toLowerCase() === "quit"
}

export function handleQuit() {
  clearScreen()
  console.log("\n  Goodbye!\n")
  closeReadline()
  process.exit(0)
}

// ============================================
// CLI Actions
// ============================================

export async function addKeys(config: Config): Promise<Config> {
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

export async function removeKeys(config: Config): Promise<Config> {
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

export async function listKeys(config: Config) {
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

export async function changePort(settings: Settings): Promise<Settings> {
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

export async function changeRotationMode(settings: Settings): Promise<Settings> {
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
