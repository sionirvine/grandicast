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
  let audioCapture = null;

  // ── AudioWorklet processor source (runs on a dedicated audio thread) ─────
  // Using an AudioWorklet instead of the deprecated ScriptProcessorNode avoids
  // main-thread stalls that cause crackling under load.
  const WORKLET_SOURCE = `
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this._size = opts.bufferSize || 4096;
    this._ch0  = new Float32Array(this._size);
    this._ch1  = new Float32Array(this._size);
    this._pos  = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this._stopped = true;
    };
  }

  process(inputs) {
    if (this._stopped) return false;
    const inp = inputs[0];
    if (!inp || !inp[0]) return true;
    const src0 = inp[0];
    const src1 = inp.length > 1 ? inp[1] : src0;
    let read = 0, rem = src0.length;

    while (rem > 0) {
      const space = this._size - this._pos;
      const n     = Math.min(rem, space);
      this._ch0.set(src0.subarray(read, read + n), this._pos);
      this._ch1.set(src1.subarray(read, read + n), this._pos);
      this._pos += n; read += n; rem -= n;

      if (this._pos >= this._size) {
        const planar = new Float32Array(this._size * 2);
        planar.set(this._ch0, 0);
        planar.set(this._ch1, this._size);
        this.port.postMessage(
          { noSamples: this._size, planar: planar.buffer },
          [planar.buffer]
        );
        this._ch0 = new Float32Array(this._size);
        this._ch1 = new Float32Array(this._size);
        this._pos = 0;
      }
    }
    return true;
  }
}
registerProcessor('audio-capture-processor', AudioCaptureProcessor);
`;

  /**
   * Preferred path: AudioWorkletNode (off-main-thread, glitch-free).
   */
  async function _createWorkletNode(audioCtx, source, bufferSize) {
    const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      await audioCtx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    const node = new AudioWorkletNode(audioCtx, "audio-capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { bufferSize },
    });

    node.port.onmessage = (e) => {
      const { noSamples, planar } = e.data;
      ipcRenderer.send("audio-pcm-data", {
        noSamples,
        planarBuf: Buffer.from(planar),
      });
    };

    source.connect(node);
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    node.connect(gain);
    gain.connect(audioCtx.destination);
    return { node, gain };
  }

  /**
   * Fallback: ScriptProcessorNode (deprecated, main-thread, may crackle).
   */
  function _createScriptNode(audioCtx, source, bufferSize) {
    const node = audioCtx.createScriptProcessor(bufferSize, 2, 2);
    node.onaudioprocess = (e) => {
      const ch0 = e.inputBuffer.getChannelData(0);
      const ch1 = e.inputBuffer.getChannelData(1);
      const noSamples = ch0.length;
      const buf = new ArrayBuffer(noSamples * 2 * 4);
      const view = new Float32Array(buf);
      view.set(ch0, 0);
      view.set(ch1, noSamples);
      ipcRenderer.send("audio-pcm-data", {
        noSamples,
        planarBuf: Buffer.from(buf),
      });
    };

    source.connect(node);
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    node.connect(gain);
    gain.connect(audioCtx.destination);
    return { node, gain };
  }

  ipcRenderer.on("start-audio-capture", async (_ev, opts) => {
    if (audioCapture) return; // already running
    const bufferSize = (opts && opts.bufferSize) || 4096;
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

      // Prefer AudioWorklet; fall back to ScriptProcessor on older Electron
      let captureNode;
      let useWorklet = false;
      try {
        captureNode = await _createWorkletNode(audioCtx, source, bufferSize);
        useWorklet = true;
      } catch (workletErr) {
        console.warn(
          "[AudioCapture] AudioWorklet unavailable, falling back to ScriptProcessor:",
          workletErr.message,
        );
        captureNode = _createScriptNode(audioCtx, source, bufferSize);
      }

      audioCapture = {
        stream,
        audioCtx,
        source,
        node: captureNode.node,
        gain: captureNode.gain,
        useWorklet,
      };
      console.log(
        `[AudioCapture] Started – 48 kHz, buffer=${bufferSize}, ` +
          `engine=${useWorklet ? "AudioWorklet" : "ScriptProcessor"}`,
      );
    } catch (err) {
      console.error("[AudioCapture] Failed to start:", err);
    }
  });

  ipcRenderer.on("stop-audio-capture", () => {
    if (!audioCapture) return;
    try {
      if (audioCapture.useWorklet && audioCapture.node.port) {
        audioCapture.node.port.postMessage("stop");
      }
      audioCapture.node.disconnect();
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
