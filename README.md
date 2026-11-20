# Grandicast

![Grandicast Main Window](img/demo_ndi_vmix_obs.gif)

An Electron-based application that captures web content (any URL) and broadcasts it as NDI® video sources over your local network. Perfect for integrating web-based graphics, dashboards, visualizations, and interactive content into live video production workflows.

This app is heavily inspired by [Vingester](https://github.com/rse/vingester). it has basically the same features, but with updated libraries. from initial testing, it has a lower latency compared to Vingester, probably due to more updated libraries and updated Chromium backend.

This is a proof-of-concept, was made for personal project, that could bypass OBS and its CEF browser and send it through NDI. personally tested on Windows 11, and Debian 13.

## Features

- 🎥 **Web to NDI Streaming** - Convert any webpage into an NDI source
- 🎛️ **Control Panel** - Manage multiple browser windows from a single interface
- 🔊 **Audio Support** - Capture and stream tab audio along with video
- 🎨 **Transparent Windows** - Support for transparent/frameless windows for overlays
- ⚙️ **Configurable Settings** - Customize resolution, FPS, and audio parameters per source
- 💾 **Settings Persistence** - Your window configurations are saved automatically
- 🔄 **Live Updates** - Modify URLs and settings without restarting NDI streams
- 🌐 **Cross-Window Communication** - BroadcastChannel bridge for multi-window web apps

## What is NDI?

NDI® (Network Device Interface) is a standard for video production over IP networks. This application allows you to stream web content to professional video production software like:

- OBS Studio (via NDI plugin)
- vMix
- Wirecast
- TriCaster
- Any NDI-compatible receiver

## Prerequisites

- **Node.js** or **Bun** runtime
- **NDI SDK** installed on your system (required by the `grandi` native module)
- Windows, macOS, or Linux

## Installation

Install dependencies:

```bash
bun install
```

Rebuild native modules for Electron:

```bash
bun run rebuild
```

## Usage

### Development Mode

Run the application in development mode:

```bash
bun run start
```

### Tests

```bash
# CLI, socket, and main-process tests
npm test

# Control panel UI tests in Chrome
npm run test:ui

# Real Electron + NDI sender/receiver end-to-end test
npm run test:e2e
```

`test:e2e` requires the Electron binary and NDI runtime installed. It starts a
real NDI stream, receives it locally, then changes size/FPS/name via CLI
commands and verifies the incoming frames change.

### Command Line

Grandicast can run headless and be controlled from a terminal. The first
instance owns the windows and NDI outputs; later invocations talk to it over a
local socket.

```bash
# Start the normal control panel
grandicast

# Start headless from a JSON config
grandicast --headless --config sources.json

# Re-apply config in a running instance
grandicast apply --config sources.json

# Add and stream a single URL
grandicast add --url https://example.com --ndi --name "Lower Third"

# Inspect and control running sources
grandicast list
grandicast start 1 --fps 60 --audio high
grandicast stop 1
grandicast close 1
grandicast quit
```

Run `grandicast --help` for all commands and options. Add `--json` for
machine-readable output. In development, use `bun run start -- <args>` instead
of the packaged `grandicast` binary.

#### JSON config

```json
{
  "windows": [
    {
      "url": "https://example.com/scoreboard",
      "width": 1920,
      "height": 1080,
      "hidden": true,
      "ndi": {
        "enabled": true,
        "name": "Scoreboard",
        "fps": 60,
        "audio": "off"
      }
    }
  ]
}
```

A bare array of window objects is also accepted. Supported per-window fields:
`url`, `width`, `height`, `transparent`, `frameless`, `hidden`, `title`, and
`ndi` (`true`/`false` or an object with `enabled`, `name`, `fps`, `audio`).
`apply` replaces the current set of windows; pass `--merge` to keep existing
windows. Launching with `--config` starts headless unless `--panel` is also
passed.

### AI Agent Skill

An agent-ready usage guide for the CLI lives at
[`skills/grandicast/SKILL.md`](skills/grandicast/SKILL.md). It covers safe
inspection, adding and updating sources, JSON configs, headless operation, and
troubleshooting.

### Build Distributable

Package the application for distribution:

```bash
bun run package
```

Create installers:

```bash
bun run make
```

### Building for Other Platforms

To build for specific platforms:

```bash
# For macOS (creates .dmg)
bun run make --platform=darwin --arch=x64,arm64

# For Linux (creates .deb and .rpm)
bun run make --platform=linux --arch=x64

# For Windows (creates .exe installer)
bun run make --platform=win32 --arch=x64
```

**⚠️ Cross-Platform Building Limitations:**

- **Building for macOS from Windows/Linux is NOT possible** due to Apple's code signing requirements and need for macOS build tools
- **Building for Linux from Windows** may work but can encounter issues with native modules
- **Building for Windows from Linux/Mac** generally works well

**Recommended approach:** Build on the target platform directly, or use CI/CD services like GitHub Actions with multiple runners (one for each OS) to build for all platforms automatically.

## How to Use

1. **Launch the Control Panel** - The application opens with a dark-themed control panel
2. **Add a Window** - Click "Add Window" to create a new browser window
3. **Configure the Window**:
   - Enter a URL to display
   - Set resolution (width × height)
   - Choose window style (normal, transparent, frameless, hidden)
4. **Start NDI Streaming**:
   - Give your NDI source a name
   - Set FPS (frames per second)
   - Enable audio capture if needed
   - Click "Start NDI"
5. **View in NDI Receiver** - Your source will appear in any NDI-compatible software on your network

## Architecture

### Core Components

- **`main.cjs`** - Main Electron process, manages windows and IPC communication
- **`ndi-manager.cjs`** - Handles NDI streaming via the `grandi` library
- **`cli.cjs`** - CLI argument parsing, JSON config loading, and the local control socket
- **`control-panel.html`** - Control panel UI for managing windows and NDI sources
- **`preload-control.cjs`** - Preload script for the control panel
- **`preload-browser.cjs`** - Preload script for browser windows, includes BroadcastChannel bridge

### Key Technologies

- **Electron** - Desktop application framework
- **grandi** - Node.js native bindings for NDI SDK
- **Bun** - JavaScript runtime and package manager
- **Electron Forge** - Build and packaging toolchain

## Configuration

Each window supports the following configuration options:

- **URL** - The webpage to display and stream
- **Resolution** - Width and height in pixels
- **Transparent** - Enable transparent background
- **Frameless** - Hide window frame/titlebar
- **Hidden** - Create window without showing it on screen
- **NDI Name** - Custom name for the NDI source
- **FPS** - Frame rate (e.g., 30, 60)
- **Audio** - Enable/disable audio capture

## Technical Details

- Video capture uses Electron's `capturePage()` API
- Audio capture uses Web Audio API with display media loopback
- NDI frames are sent as BGRA bitmaps at the specified FPS
- Audio is streamed as 48kHz stereo Float32 planar PCM
- Settings are persisted to `window-settings.json` in the user data directory

## License

By Felix Adrian

## Acknowledgments

- Built with [Electron](https://www.electronjs.org/)
- NDI streaming powered by [grandi](https://github.com/tux-tn/grandi)
- NDI® is a registered trademark of Vizrt Group
