---
name: grandicast
description: Control Grandicast from a terminal to stream web pages as NDI sources. Use this skill whenever the user wants to add, update, inspect, stop, or automate browser-based NDI streams, apply a JSON source configuration, run Grandicast headless, or manage NDI windows with the Grandicast CLI, even if they do not explicitly mention "Grandicast" or "NDI".
---

# Grandicast CLI

Grandicast captures web pages in Electron windows and sends them as NDI sources. Use its CLI to configure and control those windows from a terminal.

The CLI talks to one running Grandicast instance over a local control socket. Commands require that instance to already be running. The first instance owns the windows and NDI senders; later invocations forward commands to it.

## Before changing anything

Use JSON output for inspection:

```bash
grandicast list --json
```

A window looks like:

```json
{
  "id": 1,
  "url": "https://example.com/scoreboard",
  "width": 1920,
  "height": 1080,
  "transparent": false,
  "frameless": false,
  "hidden": true,
  "title": "Grandicast - Window 1",
  "ndiActive": true,
  "ndiName": "Scoreboard",
  "fps": 60,
  "audioPreset": "off",
  "state": "ndi"
}
```

Use `id` for subsequent commands. A window is not streaming until `ndiActive` is `true`. `state` is `running` when the window exists but NDI is stopped, and `ndi` when NDI is active.

If `grandicast` is not installed, use the packaged binary or run it from the repository with `bun run start -- <args>`.

## Start Grandicast

Normal control panel:

```bash
grandicast
```

Headless with a configuration file:

```bash
grandicast --headless --config sources.json
```

Headless with a configuration file and the control panel visible:

```bash
grandicast --panel --config sources.json
```

Do not launch a second instance with `grandicast` when you want to control an existing one. Use the CLI commands below instead.

## Core workflow

1. Inspect current state with `grandicast list --json`.
2. Add a window with `add`, or apply a full configuration with `--config`.
3. Start NDI with `add --ndi` or `start <id>`.
4. Verify with `grandicast list --json` that `ndiActive` is true and the name, resolution, and FPS match the request.
5. Change settings with `update`, then verify again.
6. Stop NDI with `stop`, remove the browser window with `close`, or stop everything with `quit`.

## Commands

### Add and stream a URL

```bash
grandicast add --url https://example.com --ndi --name "Scoreboard" --width 1920 --height 1080 --fps 60 --audio off
```

Useful add flags:

- `--ndi` starts NDI immediately.
- `--name` sets the NDI source name. Without it, Grandicast uses `Grandicast-<id>`.
- `--hidden` keeps the window off-screen while still streaming it.
- `--transparent` and `--frameless` change the window appearance.
- `--audio off|low|balanced|high|max` selects the audio buffer preset. `off` disables audio; `balanced` is the default when NDI audio is enabled.

Without `--ndi`, `add` creates the window but does not stream until `start` is called.

### Update a running window

```bash
grandicast update 1 --width 1280 --height 720 --fps 30
```

`update` accepts `--url`, `--width`, `--height`, `--title`, `--name`, `--fps`, and `--audio`. Resolution and FPS changes apply live while NDI is active. Changing the NDI name or audio preset while active restarts the sender, so the source may disappear briefly and reappear under the new name.

### Start, stop, reload, and close

```bash
grandicast start 1 --name "Camera A" --fps 30 --audio balanced
grandicast stop 1
grandicast reload 1
grandicast close 1
```

- `start` starts NDI for an existing window.
- `stop` stops NDI but leaves the browser window open.
- `reload` reloads the page.
- `close` destroys the browser window and stops its NDI output.
- `stop --all` and `close --all` affect every window.
- `quit` shuts down the whole application.

Prefer explicit numeric IDs. `close --all`, replacing configuration, and `quit` interrupt live outputs, so confirm with the user before using them during production.

## JSON configuration

Use `--config` for repeatable multi-source setups. A bare array or a `windows` object is accepted:

```json
{
  "windows": [
    {
      "url": "https://example.com/scoreboard",
      "width": 1920,
      "height": 1080,
      "hidden": true,
      "transparent": false,
      "frameless": false,
      "ndi": {
        "enabled": true,
        "name": "Scoreboard",
        "fps": 60,
        "audio": "off"
      }
    },
    {
      "url": "file:///Users/me/lower-third.html",
      "width": 1920,
      "height": 1080,
      "ndi": true
    }
  ]
}
```

`ndi` may be a boolean or an object. `ndi: true` starts NDI with a generated name and balanced audio. Use `ndi: false` or omit it to create the window without streaming. `--ndi` on the command line forces NDI on for every window in a config.

Apply configuration to a running instance:

```bash
grandicast apply --config sources.json
```

`apply` replaces all current windows by default. Use `--merge` to add the configured windows without closing existing ones:

```bash
grandicast apply --config extra.json --merge
```

Use `--config -` to read JSON from stdin, which is useful when generating configuration dynamically:

```bash
cat sources.json | grandicast apply --config -
```

## Useful automation patterns

Create one stream and print its new ID:

```bash
grandicast add --url https://example.com/scoreboard --ndi --name Scoreboard --json
```

Check whether a specific source is live without guessing text output:

```bash
grandicast list --json | jq '.windows[] | select(.ndiName == "Scoreboard") | {id, ndiActive, width, height, fps}'
```

Change layout and frame rate during a show, then verify:

```bash
grandicast update 1 --width 1280 --height 720 --fps 30
grandicast list --json
```

Run an isolated instance while testing, using a separate profile:

```bash
grandicast --headless --user-data-dir /tmp/grandicast-test --config test-sources.json
```

A custom `--user-data-dir` has its own single-instance lock and control socket. Avoid duplicate NDI names across simultaneous instances.

## Troubleshooting

- `Grandicast is not running`: start it first with `grandicast` or `grandicast --headless --config <file>`.
- `NDI unavailable`: the NDI runtime or native `grandi` module is missing. Report the error instead of retrying blindly.
- A command succeeds but no source is visible: check `ndiActive` in `list --json`, confirm the NDI receiver is on the same network, and check for duplicate source names.
- A source disappears briefly after `update --name` or `update --audio`: the sender is restarting with the new settings; re-check `list` after a short delay.
- Exit code is non-zero: read stderr and do not assume the change was applied.
