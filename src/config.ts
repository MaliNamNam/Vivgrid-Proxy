/**
 * Vivgrid Key Rotation Proxy - Configuration Management
 */

import { readFileSync, writeFileSync, existsSync } from "fs"
import { CONFIG_FILE, SETTINGS_FILE, DEFAULT_PORT } from "./constants"
import { verboseLog, verboseError } from "./logging"
import type { Config, Settings, RotationMode } from "./types"

export function loadConfig(): Config {
  if (existsSync(CONFIG_FILE)) {
    verboseLog("Loading keys config", { file: CONFIG_FILE })

    try {
      const data = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))
      return { keys: data.keys || [] }
    } catch (error) {
      verboseError("Failed to load keys config", error, { file: CONFIG_FILE })
      return { keys: [] }
    }
  }

  verboseLog("Keys config file not found, using defaults", { file: CONFIG_FILE })
  return { keys: [] }
}

export function saveConfig(config: Config) {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))

    verboseLog("Saved keys config", {
      file: CONFIG_FILE,
      keyCount: config.keys.length,
    })
  } catch (error) {
    verboseError("Failed to save keys config", error, {
      file: CONFIG_FILE,
      keyCount: config.keys.length,
    })

    throw error
  }
}

export function loadSettings(): Settings {
  if (existsSync(SETTINGS_FILE)) {
    verboseLog("Loading settings", { file: SETTINGS_FILE })

    try {
      const data = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"))
      return {
        port: data.port || DEFAULT_PORT,
        rotationMode: data.rotationMode || "balanced"
      }
    } catch (error) {
      verboseError("Failed to load settings", error, { file: SETTINGS_FILE })
      return { port: DEFAULT_PORT, rotationMode: "balanced" }
    }
  }

  verboseLog("Settings file not found, using defaults", { file: SETTINGS_FILE })
  return { port: DEFAULT_PORT, rotationMode: "balanced" }
}

export function saveSettings(settings: Settings) {
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))

    verboseLog("Saved settings", {
      file: SETTINGS_FILE,
      port: settings.port,
      rotationMode: settings.rotationMode,
    })
  } catch (error) {
    verboseError("Failed to save settings", error, {
      file: SETTINGS_FILE,
      port: settings.port,
      rotationMode: settings.rotationMode,
    })

    throw error
  }
}

export function getRotationModeDisplay(mode: RotationMode): string {
  switch (mode) {
    case "sticky":
      return "Sticky (use one key until rate-limited)"
    case "balanced":
      return "Balanced (round-robin rotation)"
  }
}
