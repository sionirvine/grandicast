"use strict";

/**
 * Preload script for browser windows.
 *
 * Replaces the native BroadcastChannel with a bridged version that routes
 * messages through the Electron main process so that windows loaded from
 * different origins can still communicate with each other.
 *
 * Runs with contextIsolation: false so the patched class is visible to the page.
 */

const { ipcRenderer } = require("electron");

(() => {
  /** @type {Map<string, Set<BridgedBroadcastChannel>>} */
  const registry = new Map();

  class BridgedBroadcastChannel extends EventTarget {
    /** @param {string} name */
    constructor(name) {
      super();
      this.name = String(name);
      this._closed = false;
      this._onmessage = null;
      this._onmessageerror = null;

      if (!registry.has(this.name)) {
        registry.set(this.name, new Set());
      }
      registry.get(this.name).add(this);
    }

    /** Post a message to every other BroadcastChannel with the same name. */
    postMessage(message) {
      if (this._closed) {
        throw new DOMException(
          "Failed to execute 'postMessage' on 'BroadcastChannel': Channel is closed",
          "InvalidStateError",
        );
      }

      const cloned = structuredClone(message);

      // Dispatch to other local instances (same window, same channel name)
      const instances = registry.get(this.name);
      if (instances) {
        for (const inst of instances) {
          if (inst !== this && !inst._closed) {
            _dispatch(inst, structuredClone(cloned));
          }
        }
      }

      // Forward to other Electron windows via main process
      try {
        ipcRenderer.send("broadcast-channel-message", {
          channel: this.name,
          message: cloned,
        });
      } catch {
        // structured-clone serialisation failure – ignore
      }
    }

    close() {
      if (this._closed) return;
      this._closed = true;
      const set = registry.get(this.name);
      if (set) {
        set.delete(this);
        if (set.size === 0) registry.delete(this.name);
      }
    }

    get onmessage() {
      return this._onmessage;
    }
    set onmessage(fn) {
      this._onmessage = typeof fn === "function" ? fn : null;
    }
    get onmessageerror() {
      return this._onmessageerror;
    }
    set onmessageerror(fn) {
      this._onmessageerror = typeof fn === "function" ? fn : null;
    }
  }

  /** Dispatch a MessageEvent asynchronously (matching spec behaviour). */
  function _dispatch(instance, data) {
    queueMicrotask(() => {
      if (instance._closed) return;
      const ev = new MessageEvent("message", { data });
      if (instance._onmessage) instance._onmessage(ev);
      instance.dispatchEvent(ev);
    });
  }

  // Receive messages forwarded from other windows
  ipcRenderer.on("broadcast-channel-message", (_ev, { channel, message }) => {
    const instances = registry.get(channel);
    if (!instances) return;
    for (const inst of instances) {
      if (!inst._closed) {
        _dispatch(inst, structuredClone(message));
      }
    }
  });

  // Replace the native BroadcastChannel globally
  window.BroadcastChannel = BridgedBroadcastChannel;
})();

// ── Tab audio capture for NDI ────────────────────────────────────────────────
(() => {
  let audioCapture = null; // { stream, audioCtx, processor, source, gain }

  ipcRenderer.on("start-audio-capture", async (_ev, opts) => {
    if (audioCapture) return; // already running
    const bufferSize = (opts && opts.bufferSize) || 2048;
    try {
      // getDisplayMedia returns the tab's own audio thanks to
      // setDisplayMediaRequestHandler in the main process
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: {
          sampleRate: 48000,
          channelCount: 2,
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
        },
        video: true, // required by Chromium even though we only want audio
      });

      // Stop the video track immediately – we only need audio
      stream.getVideoTracks().forEach((t) => t.stop());

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        console.error("[AudioCapture] No audio tracks in display media stream");
        return;
      }

      const audioCtx = new AudioContext({ sampleRate: 48000 });
      const source = audioCtx.createMediaStreamSource(
        new MediaStream(audioTracks),
      );

      const processor = audioCtx.createScriptProcessor(bufferSize, 2, 2);

      processor.onaudioprocess = (e) => {
        const ch0 = e.inputBuffer.getChannelData(0); // Float32Array
        const ch1 = e.inputBuffer.getChannelData(1);
        const noSamples = ch0.length;

        // Build planar float32 buffer: [ch0 samples][ch1 samples]
        const buf = new ArrayBuffer(noSamples * 2 * 4);
        const view = new Float32Array(buf);
        view.set(ch0, 0);
        view.set(ch1, noSamples);

        ipcRenderer.send("audio-pcm-data", {
          noSamples,
          planarBuf: Buffer.from(buf),
        });
      };

      source.connect(processor);

      // Must connect to destination for onaudioprocess to fire;
      // route through a zero-gain node to avoid doubling playback volume
      const gain = audioCtx.createGain();
      gain.gain.value = 0;
      processor.connect(gain);
      gain.connect(audioCtx.destination);

      audioCapture = { stream, audioCtx, processor, source, gain };
      console.log(`[AudioCapture] Started – 48 kHz, buffer=${bufferSize}`);
    } catch (err) {
      console.error("[AudioCapture] Failed to start:", err);
    }
  });

  ipcRenderer.on("stop-audio-capture", () => {
    if (!audioCapture) return;
    try {
      audioCapture.processor.disconnect();
      audioCapture.source.disconnect();
      audioCapture.gain.disconnect();
      audioCapture.audioCtx.close();
      audioCapture.stream.getTracks().forEach((t) => t.stop());
    } catch (e) {
      console.error("[AudioCapture] Cleanup error:", e);
    }
    audioCapture = null;
    console.log("[AudioCapture] Stopped");
  });
})();
