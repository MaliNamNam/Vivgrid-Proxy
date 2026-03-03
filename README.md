# Vivgrid Key Rotation Proxy

A Bun-based interactive CLI tool with a built-in HTTP proxy server that rotates through multiple Vivgrid API keys to avoid rate limits.

## Features

- **Interactive CLI** - Easy-to-use menu system for managing API keys
- **Key Rotation** - Automatically rotates through multiple API keys
- **Two Rotation Modes**:
  - **Balanced** - Round-robin rotation on every request
  - **Sticky** - Uses one key until rate-limited, then switches
- **Rate Limit Handling** - Automatically detects 429 responses and temporarily excludes rate-limited keys
- **Real-time Statistics** - Track request counts, errors, and rate limit status per key
- **Configurable Port** - Run the proxy on any port you prefer

## Prerequisites

### Bun Runtime

This project requires [Bun](https://bun.sh) (v1.0.0 or higher).

**Install Bun:**

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows (via PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

# Or via npm (if you have Node.js)
npm install -g bun
```

Verify installation:
```bash
bun --version
```

## Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/MaliNamNam/Vivgrid-Proxy.git
   cd Vivgrid-Proxy
   ```

2. **Install dependencies:**
   ```bash
   bun install
   ```

## Usage

### Starting the Application

```bash
# Production mode
bun run start

# Development mode (with hot reload)
bun run dev

# Or directly
bun run index.ts
```

### Main Menu

When you start the application, you'll see an interactive menu:

```
╔═══════════════════════════════════════════════╗
║       Vivgrid Key Rotation Proxy              ║
╚═══════════════════════════════════════════════╝

  Keys loaded: 0
  Port: 3456
  Rotation: Balanced (round-robin rotation)

  1. Run the proxy
  2. Add keys
  3. Remove keys
  4. List keys
  5. Change port
  6. Change rotation mode

  q. Quit
```

### Adding API Keys

1. Select option `2` from the main menu
2. Enter your Vivgrid API keys one per line
3. Optionally provide a name for each key (for easier identification)
4. Type `done` when finished

### Running the Proxy

1. Make sure you have at least one API key configured
2. Select option `1` from the main menu
3. The proxy will start on the configured port (default: 3456)

### Proxy Endpoints

Once running, the proxy exposes:

| Endpoint | Description |
|----------|-------------|
| `/v1/*` | Proxies requests to Vivgrid API with automatic key rotation |
| `/health` | Health check endpoint |
| `/stats` | Returns key usage statistics (requests, errors, rate limits) |

### Configuring Your Application

Update your application to use the proxy instead of the Vivgrid API directly.

**Example for OpenCode (`opencode.json`):**
```json
{
  "provider": {
    "vivgrid-anth": {
      "npm": "@ai-sdk/anthropic",
      "name": "vivgrid(anthropic)",
      "options": {
        "baseURL": "http://localhost:3456/v1",
        "apiKey": "proxy-managed",
        "timeout": 300000
      },
      "models": {
        "claude-opus-4.5": {
          "id": "claude-opus-4-5",
          "name": "Claude Opus 4.5 Thinking",
          "limit": {
            "context": 200000,
            "output": 16000
          },
          "reasoning": true,
          "interleaved": true,
          "modalities": {
            "input": ["image", "text"],
            "output": ["text"]
          }
        }
      }
    }
  }
}
```

> **Note:** The `apiKey` can be any placeholder value (e.g., `"proxy-managed"`) since the proxy injects the real API key automatically.

**Example for other applications:**
```bash
# Instead of:
# https://api.vivgrid.com/v1/chat/completions

# Use:
# http://localhost:3456/v1/chat/completions
```

## Rotation Modes

### Balanced Mode (Default)
- Distributes requests evenly across all keys using round-robin
- Best for: Maximum throughput when you have many keys

### Sticky Mode
- Uses a single key until it hits a rate limit
- Automatically switches to the next available key when rate-limited
- Best for: Minimizing key switches, useful when you want to maximize usage of each key

## Configuration Files

The application creates two configuration files in the project directory:

| File | Contents |
|------|----------|
| `keys.json` | Your API keys (automatically excluded from git) |
| `settings.json` | Port and rotation mode settings |

## Response Headers

The proxy adds custom headers to responses for debugging:

| Header | Description |
|--------|-------------|
| `x-proxy-key-index` | Which key (1-indexed) handled the request |
| `x-proxy-rotation-mode` | Current rotation mode (`balanced` or `sticky`) |

## Navigation

Throughout the CLI, you can use:
- `b` or `back` - Go back to the previous menu
- `q` or `quit` - Exit the application

## Security Notes

- API keys are stored locally in `keys.json`
- The `.gitignore` file excludes sensitive files from version control
- Never commit your `keys.json` file to a public repository

## License

MIT
