"use strict";

let grandi;
try {
  grandi = require("grandi");
} catch (e) {
  console.warn("[NdiManager] grandi not available:", e.message);
  grandi = null;
}

/**
 * Manages an NDI sender for a single Electron BrowserWindow.
 *
 * Receives the frames the window paints (webContents.beginFrameSubscription),
 * converts the latest one to a raw BGRA bitmap and pushes it through a grandi
 * sender at the configured FPS. Polling capturePage() every frame instead
 * made hover effects flicker in the on-screen window, so capturePage() is only
 * a fallback for windows that aren't painting (e.g. hidden ones).
 */

// Fall back to capturePage() when no painted frame has arrived for this long
const FRAME_STALE_MS = 1000;
class NdiManager {
  /**
   * @param {number} windowId
   * @param {import('electron').BrowserWindow} browserWindow
   */
  constructor(windowId, browserWindow) {
    this.windowId = windowId;
    this.browserWindow = browserWindow;
    this.sender = null;
    this.running = false;
    this._timeout = null;
    this.fps = 30;
    this.width = 1280;
    this.height = 720;
    this.audioEnabled = false;
    this._audioSampleRate = 48000;
    this._audioChannels = 2;
    this._audioLogDone = false;
    this._audioDraining = false;

    /** @type {Array<{data: Buffer, noSamples: number}>} */
    this._audioQueue = [];

    /** @type {import('electron').NativeImage | null} latest painted frame */
    this._latestFrame = null;
    this._frameAt = 0;
    this._subscribed = false;
    /** Bitmap of _latestFrame at the output size, reused until either changes */
    this._bitmapCache = null;
  }

  /** @private */
  _subscribeFrames() {
    const wc = this.browserWindow.webContents;
    try {
      wc.beginFrameSubscription(false, (image) => {
        this._latestFrame = image;
        this._frameAt = performance.now();
      });
      this._subscribed = true;
    } catch (err) {
      // Every frame then comes from the capturePage() fallback
      console.warn("[NdiManager] Frame subscription unavailable:", err.message);
    }
  }

  /** @private */
  _unsubscribeFrames() {
    if (this._subscribed && !this.browserWindow.isDestroyed()) {
      try {
        this.browserWindow.webContents.endFrameSubscription();
      } catch {
        // window is going away
      }
    }
    this._subscribed = false;
    this._latestFrame = null;
    this._bitmapCache = null;
  }

  /**
   * The current frame as a BGRA bitmap at the output size.
   * @private
   */
  async _currentBitmap() {
    const fresh =
      this._latestFrame && performance.now() - this._frameAt < FRAME_STALE_MS;
    if (!fresh !== !!this._usingFallback) {
      this._usingFallback = !fresh;
      console.log(
        `[NdiManager] Window ${this.windowId}: ` +
          (fresh
            ? "using painted frames"
            : "no painted frames, capturing the page directly"),
      );
    }
    const image = fresh
      ? this._latestFrame
      : await this.browserWindow.webContents.capturePage();

    const cache = this._bitmapCache;
    if (
      cache &&
      cache.image === image &&
      cache.width === this.width &&
      cache.height === this.height
    ) {
      return cache.bitmap;
    }

    const size = image.getSize();
    const bitmap =
      size.width !== this.width || size.height !== this.height
        ? image.resize({ width: this.width, height: this.height }).toBitmap()
        : image.toBitmap();
    this._bitmapCache = {
      image,
      width: this.width,
      height: this.height,
      bitmap,
    };
    return bitmap;
  }

  /**
   * Start capturing and sending NDI frames.
   * @param {string} ndiName  NDI source name visible on the network
   * @param {number} fps      Target frames per second
   * @param {number} width    Output width in pixels
   * @param {number} height   Output height in pixels
   * @param {boolean} audioEnabled  Whether to send audio frames
   */
  async start(ndiName, fps, width, height, audioEnabled) {
    if (!grandi) throw new Error("grandi native module is not available");
    if (this.running) await this.stop();

    this.fps = fps || 30;
    this.width = width || 1280;
    this.height = height || 720;
    this.audioEnabled = !!audioEnabled;

    this.sender = await grandi.send({
      name: ndiName,
      clockVideo: true,
      clockAudio: false,
    });

    this._audioQueue = [];
    this._subscribeFrames();

    this.running = true;
    console.log(
      `[NdiManager] Started sender "${ndiName}" – ${this.width}×${this.height} @ ${this.fps} fps (audio: ${this.audioEnabled})`,
    );
    this._loop();
  }

  /** @private */
  async _loop() {
    if (!this.running || !this.sender) return;
    if (this.browserWindow.isDestroyed()) {
      await this.stop();
      return;
    }

    const t0 = performance.now();

    const ns = process.hrtime.bigint();
    const timecode = ns / 100n;
    const timestamp = [
      Number(ns / 1_000_000_000n),
      Number(ns % 1_000_000_000n),
    ];

    // ── Video frame ──────────────────────────────────────────────────────
    try {
      const bitmap = await this._currentBitmap();

      await this.sender.video({
        xres: this.width,
        yres: this.height,
        frameRateN: this.fps,
        frameRateD: 1,
        pictureAspectRatio: this.width / this.height,
        frameFormatType: grandi.FrameType.Progressive,
        lineStrideBytes: this.width * 4,
        fourCC: grandi.FourCC.BGRA,
        data: bitmap,
        timecode,
        timestamp,
      });
    } catch (err) {
      if (this.running) {
        console.error(
          `[NdiManager] Video capture error (window ${this.windowId}):`,
          err.message,
        );
      }
    }

    // Audio is sent immediately via pushAudio() – no batching here.

    if (!this.running) return;

    const elapsed = performance.now() - t0;
    const interval = 1000 / this.fps;
    const delay = Math.max(1, interval - elapsed);
    this._timeout = setTimeout(() => this._loop(), delay);
  }

  /**
   * Queue a real audio buffer captured from the renderer for sending.
   * Sends are serialised so they never overlap on the native sender.
   * @param {Buffer} planarBuf  Float32 planar PCM (ch0 then ch1)
   * @param {number} noSamples  Number of samples per channel
   */
  pushAudio(planarBuf, noSamples) {
    if (!this.running || !this.audioEnabled || !this.sender) return;

    // Back-pressure: if the NDI sender can't keep up, drop the oldest chunk
    // to prevent unbounded memory growth and accumulating latency.
    if (this._audioQueue.length >= 8) {
      this._audioQueue.shift();
    }

    this._audioQueue.push({ data: planarBuf, noSamples });
    if (!this._audioDraining) this._drainAudioQueue();
  }

  /** @private Serialise audio sends so they never overlap. */
  async _drainAudioQueue() {
    this._audioDraining = true;
    while (this._audioQueue.length > 0 && this.running && this.sender) {
      const { data, noSamples } = this._audioQueue.shift();

      const ns = process.hrtime.bigint();
      const timecode = ns / 100n;
      const timestamp = [
        Number(ns / 1_000_000_000n),
        Number(ns % 1_000_000_000n),
      ];

      try {
        await this.sender.audio({
          sampleRate: this._audioSampleRate,
          noChannels: this._audioChannels,
          noSamples,
          channelStrideBytes: noSamples * 4,
          data,
          fourCC: grandi.FourCC.FLTp,
          timecode,
          timestamp,
        });
        if (!this._audioLogDone) {
          console.log(
            `[NdiManager] First real audio frame – ${this._audioSampleRate}Hz, ` +
              `${this._audioChannels}ch, ${noSamples} samples`,
          );
          this._audioLogDone = true;
        }
      } catch (err) {
        if (this.running) {
          console.error(
            `[NdiManager] Audio send error (window ${this.windowId}):`,
            err.message,
          );
        }
      }
    }
    this._audioDraining = false;
  }

  /** Stop capturing and destroy the NDI sender. */
  async stop() {
    this.running = false;
    if (this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = null;
    }
    this._audioQueue = [];
    this._unsubscribeFrames();
    if (this.sender) {
      try {
        this.sender.destroy();
      } catch (e) {
        console.error("[NdiManager] Error destroying sender:", e.message);
      }
      this.sender = null;
    }
  }
}

module.exports = NdiManager;
