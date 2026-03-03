/**
 * Vivgrid Key Rotation Proxy
 * 
 * Interactive CLI with key management and proxy server
 */

import { VERBOSE_LOGGING, VIVGRID_BASE_URL } from "./constants"
import { loadConfig, loadSettings, getRotationModeDisplay } from "./config"
import {
  clearScreen,
  printHeader,
  printMenu,
  prompt,
  isQuit,
  handleQuit,
  addKeys,
  removeKeys,
  listKeys,
  changePort,
  changeRotationMode,
} from "./cli"
import { runProxy } from "./proxy"
import { verboseError } from "./logging"

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
  Verbose:  ${VERBOSE_LOGGING ? "enabled" : "disabled"}
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

main().catch(error => {
  verboseError("Fatal error in main loop", error)
  process.exit(1)
})
