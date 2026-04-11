import { useRef, useCallback } from "react";
import { io } from "socket.io-client";
import { useStore } from "../store";

// ═══════════════════════════════════════════════════════════════════════════════
// CRC32 — Always-on lightweight integrity verification
// Sender computes CRC32 over all sent bytes, sends final hash in a JSON
// "transfer-done" message. Receiver computes the same hash incrementally,
// compares on completion. ~1% CPU overhead, catches silent SCTP corruption.
// ═══════════════════════════════════════════════════════════════════════════════
const CRC32_TABLE = new Uint32Array(256);
(function buildCRC32Table() {
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    CRC32_TABLE[i] = c >>> 0;
  }
})();

function crc32Update(crc, buf) {
  const bytes = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer || buf);
  for (let i = 0; i < bytes.length; i++)
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return crc >>> 0;
}
function crc32Finalize(crc) { return (crc ^ 0xFFFFFFFF) >>> 0; }

// ═══════════════════════════════════════════════════════════════════════════════
// Adaptive Engine — auto-detects browser capabilities, tunes transfer params
// No hardcoded Chrome-specific values. Chrome gets max throughput, Firefox/
// Safari/mobile get stable transfers at conservative-but-fast settings.
// ═══════════════════════════════════════════════════════════════════════════════
function detectEngine() {
  const ua = navigator.userAgent;
  const isChrome  = /Chrome\//.test(ua) && !/Edg/.test(ua);
  const isFirefox = /Firefox\//.test(ua);
  const isSafari  = /Safari\//.test(ua) && !isChrome;
  const isMobile  = /Mobi|Android|iPhone|iPad/.test(ua);
  const hasFS     = typeof window.showSaveFilePicker === "function";

  return {
    // Chrome SCTP handles 256 KB messages well; Firefox/Safari safer at 64 KB
    chunkSize:   isChrome ? 256 * 1024 : 64 * 1024,
    // Disk read block — smaller on mobile to limit peak memory
    blockSize:   isMobile ? 4 * 1024 * 1024 : 16 * 1024 * 1024,
    // Backpressure thresholds — lower for constrained browsers
    bufferHigh:  isMobile ? 512 * 1024 : (isChrome ? 2 * 1024 * 1024 : 1024 * 1024),
    bufferLow:   isMobile ? 64  * 1024 : 256 * 1024,
    // Yield to event loop every N chunks (keeps UI responsive on mobile)
    yieldEvery:  isMobile ? 4 : 8,
    // Use FSAPI streaming above this threshold (only when API available)
    streamThreshold: hasFS ? 100 * 1024 * 1024 : Infinity,
    // Flush partial blobs every N bytes when FSAPI unavailable (limits peak RAM)
    blobFlushBytes: isMobile ? 25 * 1024 * 1024 : 50 * 1024 * 1024,
    // Browser flags
    hasFS, isChrome, isFirefox, isSafari, isMobile,
  };
}

const ENGINE = detectEngine();

// ═══════════════════════════════════════════════════════════════════════════════
// Timing & thresholds
// ═══════════════════════════════════════════════════════════════════════════════
const UI_UPDATE_MS      = 100;      // ~10 fps progress updates
const STALL_TIMEOUT_MS  = 15000;    // 15 s no-progress → stalled (was 60 s)
const BP_INITIAL_MS     = 5000;     // initial backpressure timeout
const BP_MIN_MS         = 2000;
const BP_MAX_MS         = 30000;

// ═══════════════════════════════════════════════════════════════════════════════
// Adaptive Broadcast Concurrency
// For a 100-student classroom: ramp up to 20 concurrent WebRTC channels.
// Each channel is independent (separate PC + DataChannel), so bandwidth is
// divided across active slots. 20 is a safe ceiling for a laptop host.
// ═══════════════════════════════════════════════════════════════════════════════
function getMaxBroadcastSlots() {
  // Ramp up as active count grows — start with a burst then plateau
  if (_activeBroadcastCount === 0)  return 8;
  if (_activeBroadcastCount < 10)   return 16;
  return 20;
}

let   _activeBroadcastCount = 0;
const _broadcastSendQueue   = [];
let   _bcQueueRunning       = false; // guard against re-entrant draining

function isBroadcastTransfer(id) { return id?.startsWith("bc-"); }

function processBroadcastQueue() {
  if (_bcQueueRunning) return;
  _bcQueueRunning = true;
  (function drain() {
    const maxSlots = getMaxBroadcastSlots();
    if (_broadcastSendQueue.length === 0 || _activeBroadcastCount >= maxSlots) {
      _bcQueueRunning = false;
      return;
    }
    const { from, transferId, peerName } = _broadcastSendQueue.shift();
    _activeBroadcastCount++;
    useStore.getState().updateOutgoing(transferId, { status: "connecting" });
    _activeTransferPeer[from] = transferId;
    // createOffer is async but we don't await — each peer is independent.
    // setTimeout(0) between each offer unwinds the call stack so the event
    // loop can process ICE/signal messages between offer creations.
    createOffer(transferId, from, peerName).catch(err =>
      console.error(`Broadcast offer failed for ${transferId}:`, err)
    );
    setTimeout(drain, 0);
  })();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Module state
// ═══════════════════════════════════════════════════════════════════════════════
let _socket = null;
let _serverConfig = null;
const _peerConns         = {};
const _dataChans         = {};
const _recvBufs          = {};
const _pendFiles         = {};
const _sending           = {};
const _queue             = {};
let   _activeTransferPeer = {};

// Persistent broadcast file registry — keyed by bcId (e.g. "bc-1234567890").
// Unlike _pendFiles, entries here are NEVER deleted by cleanup() so late joiners
// can always resolve the file regardless of when they accept.
// Cleared only on reset() / endSession().
const _broadcastFiles    = {};  // bcId → File

// Streaming writers (FSAPI), stall timers, async write queues
const _streamWriters = {};   // transferId → FileSystemWritableFileStream
const _stallTimers   = {};   // transferId → setInterval id
const _writeQueues   = {};   // transferId → Promise chain

// ═══════════════════════════════════════════════════════════════════════════════
// Helper: format seconds → "MM:SS"
// ═══════════════════════════════════════════════════════════════════════════════
function formatETA(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Stall detection — 15 s with no byte progress triggers onStall callback
// ═══════════════════════════════════════════════════════════════════════════════
function startStallTimer(transferId, getBytes, onStall) {
  clearStallTimer(transferId);
  const state = { lastBytes: getBytes() };
  const timer = setInterval(() => {
    const current = getBytes();
    if (current === state.lastBytes) {
      console.warn(`🚨 Transfer stalled (${transferId}) — no progress for ${STALL_TIMEOUT_MS / 1000}s`);
      clearStallTimer(transferId);
      onStall();
    } else {
      state.lastBytes = current;
    }
  }, STALL_TIMEOUT_MS);
  _stallTimers[transferId] = timer;
}

function clearStallTimer(transferId) {
  if (_stallTimers[transferId]) {
    clearInterval(_stallTimers[transferId]);
    delete _stallTimers[transferId];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Queue helpers — same-peer sequential transfers
// ═══════════════════════════════════════════════════════════════════════════════
function enqueueTransfer(peerId, transferId, file, peerName) {
  if (!_queue[peerId]) _queue[peerId] = [];
  _queue[peerId].push({ transferId, file, peerName });
}
function dequeueTransfer(peerId) { return _queue[peerId]?.shift() ?? null; }
function clearPeerQueue(peerId)  { delete _queue[peerId]; delete _activeTransferPeer[peerId]; }

function advanceQueue(peerId) {
  delete _activeTransferPeer[peerId];
  const next = dequeueTransfer(peerId);
  if (!next) return;
  console.log(`▶️ Queue advance → ${peerId}: ${next.file.name}`);
  _pendFiles[next.transferId] = next.file;
  _activeTransferPeer[peerId] = next.transferId;
  _socket?.emit("file-request", {
    to: peerId, transferId: next.transferId, fromQueue: true,
    fileInfo: { name: next.file.name, size: next.file.size, type: next.file.type },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Session persistence
// ═══════════════════════════════════════════════════════════════════════════════
export function setServerConfig(c) { _serverConfig = c; }
const SESSION_KEY = "swiftdrop_session";
const GUEST_SESSION_ENDED_KEY = "swiftdrop_guest_session_ended";
export function saveSession(data)  { try { localStorage.setItem(SESSION_KEY, JSON.stringify(data)); } catch (_) {} }
export function loadSession()      { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (_) { return null; } }
export function clearSession()     { try { localStorage.removeItem(SESSION_KEY); } catch (_) {} }
export function markGuestSessionEnded() { try { localStorage.setItem(GUEST_SESSION_ENDED_KEY, "1"); } catch (_) {} }
export function clearGuestSessionEnded() { try { localStorage.removeItem(GUEST_SESSION_ENDED_KEY); } catch (_) {} }
export function isGuestSessionEnded() { try { return localStorage.getItem(GUEST_SESSION_ENDED_KEY) === "1"; } catch (_) { return false; } }

// ═══════════════════════════════════════════════════════════════════════════════
// WebRTC — build PeerConnection
// ═══════════════════════════════════════════════════════════════════════════════
function buildPC(transferId, toPeerId) {
  if (_peerConns[transferId]) _peerConns[transferId].close();

  const iceServers = _serverConfig ? [{
    urls: [
      `turn:${_serverConfig.turnIp}:${_serverConfig.turnPort}?transport=udp`,
      `turn:${_serverConfig.turnIp}:${_serverConfig.turnPort}?transport=tcp`,
    ],
    username: _serverConfig.turnUser,
    credential: _serverConfig.turnPass,
  }] : [];

  const pc = new RTCPeerConnection({
    iceServers,
    iceTransportPolicy: "all",
    iceCandidatePoolSize: ENGINE.isMobile ? 4 : 10,
  });
  pc._toPeer = toPeerId;
  pc.onicecandidate = (e) => {
    if (e.candidate && _socket)
      _socket.emit("signal", { to: toPeerId, signal: { candidate: e.candidate, transferId } });
  };
  pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === "failed") pc.restartIce(); };
  pc.ondatachannel = (e) => setupReceiveChannel(e.channel, transferId, toPeerId);
  _peerConns[transferId] = pc;
  return pc;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECEIVER — handles incoming DataChannel messages
// ═══════════════════════════════════════════════════════════════════════════════
function setupReceiveChannel(channel, transferId, fromPeerId) {
  channel.binaryType = "arraybuffer";
  _dataChans[transferId] = channel;
  channel.onopen = () => console.log("✅ DataChannel OPEN (RECEIVER):", transferId);

  channel.onmessage = (e) => {
    const store = useStore.getState();

    // ── JSON messages: metadata or completion ──
    if (typeof e.data === "string") {
      try {
        const parsed = JSON.parse(e.data);

        // Completion message with CRC32 hash
        if (parsed.type === "transfer-done") {
          const buf = _recvBufs[transferId];
          if (buf && !buf.done) {
            buf.done = true;
            buf.expectedCRC = parsed.crc32;
            clearStallTimer(transferId);
            finishReceive(transferId, fromPeerId);
          }
          return;
        }

        // Initial metadata — create receive buffer
        if (!_recvBufs[transferId]) {
          _recvBufs[transferId] = {
            chunks: [],          // raw ArrayBuffer accumulator
            received: 0,
            meta: parsed,
            startTime: Date.now(),
            done: false,
            lastUpdate: 0,
            crc: 0xFFFFFFFF,     // running CRC32
            partialBlobs: [],    // periodic blob flushes (non-FSAPI)
            partialBlobBytes: 0, // bytes since last partial flush
          };
        }
        if (!store.activeTransfers[transferId]) {
          store.startActiveTransfer(transferId, {
            direction: "receiving", peerId: fromPeerId,
            peerName: parsed.senderName || "Peer",
            fileInfo: { name: parsed.name, size: parsed.size, type: parsed.type },
          });
        }
        // Start stall detection
        startStallTimer(
          transferId,
          () => _recvBufs[transferId]?.received ?? 0,
          () => store.updateTransferProgress(transferId, { status: "stalled", phase: "stalled" }),
        );
      } catch (err) {
        console.error("Receive JSON parse error:", err);
      }
      return;
    }

    // ── Binary data chunks ──
    const buf = _recvBufs[transferId];
    if (!buf) return;

    buf.received += e.data.byteLength;
    if (buf.received > buf.meta.size) buf.received = buf.meta.size;

    // Update rolling CRC32
    buf.crc = crc32Update(buf.crc, e.data);

    // ── FSAPI streaming path — write to disk immediately ──
    if (_streamWriters[transferId]) {
      const chunk = e.data;
      if (!_writeQueues[transferId]) _writeQueues[transferId] = Promise.resolve();
      _writeQueues[transferId] = _writeQueues[transferId].then(async () => {
        try {
          await _streamWriters[transferId].write(chunk);
        } catch (err) {
          console.error("Stream write error — falling back to memory:", err);
          delete _streamWriters[transferId];
          buf.chunks.push(chunk);
        }
      });
    } else {
      // ── Memory path — with periodic blob flush for large files ──
      buf.chunks.push(e.data);
      buf.partialBlobBytes += e.data.byteLength;

      // On non-FSAPI browsers, periodically flush accumulated chunks into
      // a partial Blob to cap peak RAM usage. Blob constructor is lazy
      // (doesn't copy), so this frees the ArrayBuffer references.
      if (!ENGINE.hasFS && buf.partialBlobBytes >= ENGINE.blobFlushBytes) {
        buf.partialBlobs.push(new Blob(buf.chunks));
        buf.chunks = [];
        buf.partialBlobBytes = 0;
      }
    }

    // Throttled UI update with ETA
    const now = Date.now();
    if (now - buf.lastUpdate > UI_UPDATE_MS || buf.received >= buf.meta.size) {
      const elapsed   = (now - buf.startTime) / 1000 || 0.001;
      const speedNum  = (buf.received * 8) / 1e6 / elapsed; // bytes → Mbps
      const speed     = speedNum.toFixed(1);
      const progress  = Math.min((buf.received / buf.meta.size) * 100, 100);
      const remaining = buf.meta.size - buf.received;
      const bps       = buf.received / elapsed;
      const eta       = formatETA(bps > 0 ? remaining / bps : 0);
      store.updateTransferProgress(transferId, { progress, speed, eta, phase: "transferring" });
      buf.lastUpdate = now;
    }
  };
}

// ── Receiver: finish & verify ──
async function finishReceive(transferId, fromPeerId) {
  const buf = _recvBufs[transferId];
  if (!buf) return;

  const store = useStore.getState();
  store.updateTransferProgress(transferId, { phase: "verifying" });

  // Wait for all queued disk writes to complete
  if (_writeQueues[transferId]) await _writeQueues[transferId];

  // ── CRC32 verification ──
  const computedCRC = crc32Finalize(buf.crc);
  if (buf.expectedCRC !== undefined && computedCRC !== buf.expectedCRC) {
    console.error(
      `❌ CRC32 MISMATCH for ${buf.meta.name}: ` +
      `expected 0x${buf.expectedCRC.toString(16)}, got 0x${computedCRC.toString(16)}`
    );
    store.updateTransferProgress(transferId, { phase: "corrupt", status: "corrupt" });
    _socket?.emit("transfer-complete", { peerId: fromPeerId, transferId, role: "receiver", corrupt: true });
    setTimeout(() => cleanup(transferId), 5000);
    return;
  }
  console.log(`✅ CRC32 verified: ${buf.meta.name} (0x${computedCRC.toString(16)})`);

  // ── Save the file ──
  if (_streamWriters[transferId]) {
    // FSAPI: close the writable stream — file is already on disk
    try {
      await _streamWriters[transferId].close();
      console.log("✅ Stream closed:", buf.meta.name);
    } catch (err) { console.error("Stream close error:", err); }
    delete _streamWriters[transferId];
    delete _writeQueues[transferId];
  } else {
    // Memory: assemble from partial blobs + remaining chunks
    const allParts = [...buf.partialBlobs, ...buf.chunks];
    const blob = new Blob(allParts, { type: buf.meta.type || "application/octet-stream" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.style.display = "none";
    a.href = url;
    a.download = buf.meta.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 5000);
  }

  store.completeTransfer(transferId);
  _socket?.emit("transfer-complete", { peerId: fromPeerId, transferId, role: "receiver" });
  setTimeout(() => cleanup(transferId), 3000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SENDER — reads file in blocks, sends over DataChannel with adaptive
// backpressure, CRC32 hashing, and ETA tracking
// ═══════════════════════════════════════════════════════════════════════════════
function sendOverChannel(transferId, file, toPeerId, toPeerName) {
  if (_sending[transferId]) return;
  _sending[transferId] = true;

  const dc = _dataChans[transferId];
  if (!dc || dc.readyState !== "open") return;

  const store = useStore.getState();
  store.startActiveTransfer(transferId, {
    direction: "sending", peerId: toPeerId, peerName: toPeerName,
    fileInfo: { name: file.name, size: file.size, type: file.type },
  });

  // Send metadata as first message
  dc.send(JSON.stringify({
    name: file.name, size: file.size, type: file.type,
    senderId: _socket?.id, senderName: store.myName,
  }));

  let offset      = 0;
  let senderCRC   = 0xFFFFFFFF;
  const t0        = Date.now();
  let lastUpdate  = 0;
  dc.bufferedAmountLowThreshold = ENGINE.bufferLow;

  // Adaptive backpressure: track drain times to auto-tune timeout
  const drainHistory = [];
  let bpTimeout = BP_INITIAL_MS;

  // Stall detection on sender side
  // For broadcast transfers, a stalled peer is re-queued for retry so the
  // professor doesn't have to manually resend. For 1-to-1 transfers, mark stalled.
  startStallTimer(
    transferId,
    () => offset,
    () => {
      console.error(`🚨 Sender stalled on ${transferId}`);
      if (isBroadcastTransfer(transferId)) {
        console.warn(`♻️ Re-queuing stalled broadcast peer (${transferId})`);
        // cleanup() wipes _pendFiles[transferId] and _sending[transferId].
        // Call it first, then restore from the persistent registry.
        cleanup(transferId);
        delete _activeTransferPeer[toPeerId]; // clear stale slot
        _activeBroadcastCount = Math.max(0, _activeBroadcastCount - 1);
        // Restore file from persistent registry (never wiped by cleanup)
        const bcId = transferId.match(/^(bc-\d+)/)?.[1];
        _pendFiles[transferId] = bcId ? _broadcastFiles[bcId] : undefined;
        if (!_pendFiles[transferId]) {
          console.error(`♻️ Cannot retry ${transferId} — file no longer in registry`);
          return;
        }
        _broadcastSendQueue.push({ from: toPeerId, transferId, peerName: toPeerName });
        processBroadcastQueue();
      } else {
        useStore.getState().updateOutgoing(transferId, { status: "stalled" });
      }
    },
  );

  async function sendNext() {
    while (offset < file.size) {
      if (dc.readyState !== "open") { delete _sending[transferId]; return; }

      // Read next block from disk
      const blockStart = offset;
      const blockEnd   = Math.min(blockStart + ENGINE.blockSize, file.size);
      const block      = await file.slice(blockStart, blockEnd).arrayBuffer();

      let localOffset     = 0;
      let chunksSinceYield = 0;

      while (localOffset < block.byteLength) {
        if (dc.readyState !== "open") { delete _sending[transferId]; return; }

        // ── Adaptive Backpressure ──
        // Wait BEFORE sending if the SCTP buffer is too full.
        // Timeout adapts based on observed drain rate history.
        if (dc.bufferedAmount > ENGINE.bufferHigh) {
          const drainStart = Date.now();
          const drained = await Promise.race([
            new Promise(resolve => {
              dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; resolve(true); };
            }),
            new Promise(resolve => setTimeout(() => resolve(false), bpTimeout)),
          ]);
          if (drained) {
            const drainMs = Date.now() - drainStart;
            drainHistory.push(drainMs);
            if (drainHistory.length > 10) drainHistory.shift();
            const avg = drainHistory.reduce((a, b) => a + b, 0) / drainHistory.length;
            bpTimeout = Math.max(BP_MIN_MS, Math.min(avg * 3, BP_MAX_MS));
          } else {
            if (dc.readyState !== "open") { delete _sending[transferId]; return; }
            console.warn(
              `⚠️ BP timeout (${transferId}), buffered: ` +
              `${(dc.bufferedAmount / 1024 / 1024).toFixed(1)}MB — continuing`
            );
          }
        }

        const chunkEnd = Math.min(localOffset + ENGINE.chunkSize, block.byteLength);
        const chunk    = block.slice(localOffset, chunkEnd);

        // Update sender CRC32
        senderCRC = crc32Update(senderCRC, chunk);

        dc.send(chunk);
        localOffset = chunkEnd;
        offset      = blockStart + localOffset;
        chunksSinceYield++;

        // Throttled UI update with ETA
        const now = Date.now();
        if (now - lastUpdate > UI_UPDATE_MS || offset >= file.size) {
          const elapsed   = (now - t0) / 1000 || 0.001;
          const speedNum  = (offset * 8) / 1e6 / elapsed; // bytes → Mbps
          const speed     = speedNum.toFixed(1);
          const progress  = Math.min((offset / file.size) * 100, 100);
          const remaining = file.size - offset;
          const bps       = offset / elapsed;
          const eta       = formatETA(bps > 0 ? remaining / bps : 0);
          const s = useStore.getState();
          s.updateTransferProgress(transferId, { progress, speed, eta, phase: "transferring" });
          s.updateOutgoing(transferId, { status: "sending", progress, speed, eta });
          lastUpdate = now;
        }

        // Yield periodically so SCTP can flush and other channels progress
        if (chunksSinceYield >= ENGINE.yieldEvery) {
          chunksSinceYield = 0;
          await new Promise(r => setTimeout(r, 0));
        }
      }
    }

    // ── All bytes read & queued ──
    clearStallTimer(transferId);
    const finalCRC = crc32Finalize(senderCRC);

    useStore.getState().updateTransferProgress(transferId, { phase: "flushing" });

    // Wait for SCTP buffer to drain before sending completion message
    await new Promise(resolve => {
      const deadline = Date.now() + 30000;
      const check = () => {
        if (dc.bufferedAmount === 0 || dc.readyState !== "open" || Date.now() > deadline) resolve();
        else setTimeout(check, 50);
      };
      check();
    });

    // Send CRC32 completion message
    if (dc.readyState === "open") {
      dc.send(JSON.stringify({ type: "transfer-done", crc32: finalCRC }));
    }

    // Final small drain for the completion message itself
    await new Promise(resolve => {
      const deadline = Date.now() + 10000;
      const check = () => {
        if (dc.bufferedAmount === 0 || dc.readyState !== "open" || Date.now() > deadline) resolve();
        else setTimeout(check, 50);
      };
      check();
    });

    console.log(`✅ All chunks flushed + CRC32 sent: ${transferId} (0x${finalCRC.toString(16)})`);
    useStore.getState().updateOutgoing(transferId, { status: "done" });
    _socket?.emit("transfer-complete", { peerId: toPeerId, transferId, role: "sender" });
    delete _sending[transferId];

    // Delay cleanup so receiver can finish before we tear down PC
    setTimeout(() => {
      useStore.getState().completeTransfer(transferId);
      cleanup(transferId);

      if (isBroadcastTransfer(transferId)) {
        _activeBroadcastCount = Math.max(0, _activeBroadcastCount - 1);
        processBroadcastQueue();
      }

      advanceQueue(toPeerId);
    }, 3000);
  }

  sendNext();
}

// ═══════════════════════════════════════════════════════════════════════════════
// WebRTC offer/answer
// ═══════════════════════════════════════════════════════════════════════════════
async function createOffer(transferId, toPeerId, toPeerName) {
  const pc = buildPC(transferId, toPeerId);
  const dc = pc.createDataChannel("fileTransfer", { ordered: true });
  dc.binaryType = "arraybuffer";
  _dataChans[transferId] = dc;

  dc.onopen = () => {
    console.log("✅ DataChannel OPEN (SENDER):", transferId);
    const file = _pendFiles[transferId];
    if (file) { sendOverChannel(transferId, file, toPeerId, toPeerName); delete _pendFiles[transferId]; }
    else console.error("❌ File not found for transfer:", transferId);
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  _socket?.emit("signal", { to: toPeerId, signal: { ...offer, transferId } });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════════════════════════════════════════
function cleanup(transferId) {
  _peerConns[transferId]?.close();
  delete _peerConns[transferId];
  delete _dataChans[transferId];
  delete _recvBufs[transferId];
  delete _pendFiles[transferId];
  delete _sending[transferId];          // must clear so retry path isn't blocked
  clearStallTimer(transferId);
  if (_streamWriters[transferId]) {
    _streamWriters[transferId].close().catch(() => {});
    delete _streamWriters[transferId];
  }
  delete _writeQueues[transferId];
}

// ═══════════════════════════════════════════════════════════════════════════════
// React Hook
// ═══════════════════════════════════════════════════════════════════════════════
export function useSwiftDrop() {
  const initialized = useRef(false);

  const initSocket = useCallback((serverUrl) => {
    if (initialized.current && _socket?.connected) return _socket;
    if (_socket) _socket.disconnect();

    const sock = io(serverUrl, { transports: ["websocket"], reconnectionAttempts: 20, reconnectionDelay: 1000 });
    _socket = sock;
    window._swiftSock = sock;
    initialized.current = true;

    sock.on("connect", () => {
      console.log("✅ Socket connected:", sock.id);
      const sess = loadSession();
      if (sess?.token && !useStore.getState().roomId) {
        sock.emit("rejoin-room", { token: sess.token }, (res) => {
          if (res.error) { clearSession(); return; }
          useStore.setState({
            role: res.isHost ? "host" : "guest",
            roomId: res.roomId, myName: sess.name, myDevice: sess.device,
            isHost: res.isHost, hostId: res.hostId,
            peers: res.peers || [], roomSettings: res.settings, pendingRoom: null,
          });
          saveSession({ ...sess, token: res.token });
        });
      } else {
        const state = useStore.getState();
        if (!state.roomId && state.pendingRoom?.roomId && state.pendingRoom?.name) {
          sock.emit("join-room", {
            roomId: state.pendingRoom.roomId,
            name: state.pendingRoom.name,
            device: state.pendingRoom.device,
          }, (res) => {
            if (res.error) return;
            useStore.setState({
              role: "guest", roomId: state.pendingRoom.roomId,
              myName: state.pendingRoom.name, myDevice: state.pendingRoom.device,
              isHost: false, hostId: res.hostId,
              peers: res.peers || [], roomSettings: res.settings, pendingRoom: null,
            });
            saveSession({ name: state.pendingRoom.name, device: state.pendingRoom.device, token: res.token });
          });
        }
      }
    });

    sock.on("peer-list",     (peers)    => useStore.getState().setPeers(peers));
    sock.on("room-settings", (settings) => useStore.getState().setRoomSettings(settings));
    sock.on("guest-left",    ({ id })   => console.log("Guest left:", id));

    // Broadcast acknowledgement from server
    sock.on("broadcast-sent", ({ count, transferId }) => {
      console.log(`📢 Broadcast sent to ${count} peers (${transferId})`);
    });

    sock.on("kicked", () => {
      clearSession();
      clearGuestSessionEnded();
      useStore.getState().reset();
      window.location.href = "/";
    });
    sock.on("session-ended", () => {
      const wasHost = !!useStore.getState().isHost;
      clearSession();
      // Clear any lingering broadcast state
      Object.keys(_broadcastFiles).forEach(k => delete _broadcastFiles[k]);
      _broadcastSendQueue.length = 0;
      _activeBroadcastCount = 0;
      if (wasHost) {
        clearGuestSessionEnded();
        useStore.getState().reset();
        return;
      }
      markGuestSessionEnded();
      useStore.setState({
        sessionEndedMsg: "The session has been ended by the host.",
        leaveStatus: null,
      });
    });

    sock.on("host-create-request", (req) => {
      useStore.getState().addHostCreateRequest(req);
    });

    // Approval granted — re-emit create-room immediately with the same params.
    // The server marks the socket as approved for a 2-min window so this succeeds.
    sock.on("host-create-approved", ({ requestId }) => {
      useStore.getState().removeHostCreateRequest(requestId);
      const state = useStore.getState();
      // Pull the pending room info that was stored when the first create-room attempt was made
      const pending = state.pendingHostCreate;
      if (!pending) return;
      useStore.setState({ pendingHostCreate: null });
      sock.emit("create-room", { roomId: pending.roomId, name: pending.name, device: pending.device }, (res) => {
        if (res.error) {
          useStore.setState({ hostCreateError: res.error });
          return;
        }
        if (res.ok) {
          useStore.setState({
            role: "host", roomId: pending.roomId, myName: pending.name,
            myDevice: pending.device, isHost: true,
            roomSettings: res.settings, pendingRoom: null,
          });
          // saveSession is imported at module level
          saveSession({ name: pending.name, device: pending.device, token: res.token });
        }
      });
    });

    sock.on("host-create-denied", ({ requestId, message }) => {
      useStore.getState().removeHostCreateRequest(requestId);
      useStore.setState({ pendingHostCreate: null, hostCreateError: message || "Request denied." });
    });

    sock.on("file-request", (req) => {
      // Auto-accept broadcast files — all guests start receiving simultaneously
      // for fairness (exam/assignment scenarios). No manual accept needed.
      if (req.isBroadcast) {
        sock.emit("file-accepted", { to: req.from, transferId: req.transferId });
        return;
      }
      useStore.getState().addIncomingRequest(req);
    });
    sock.on("transfer-denied", ({ transferId, reason }) => useStore.getState().updateOutgoing(transferId, { status: "denied", reason }));

    sock.on("file-accepted", async ({ from, transferId }) => {
      if (_sending[transferId]) return;
      resolveBroadcastFile(transferId);
      const peer = useStore.getState().peers.find(p => p.id === from);
      const peerName = peer?.name || "Peer";

      // ── Broadcast transfers ──
      // Route through _broadcastSendQueue so concurrency is managed uniformly
      // for BOTH original recipients and late joiners. This also prevents the
      // _activeBroadcastCount from going negative when late-joiner paths bypass
      // processBroadcastQueue's increment.
      if (isBroadcastTransfer(transferId)) {
        const file = _pendFiles[transferId];
        if (!file) {
          console.error(`❌ Broadcast file not found for late joiner (${transferId}) — broadcast registry may be empty`);
          return;
        }
        if (!useStore.getState().outgoingQueue.find(o => o.transferId === transferId)) {
          useStore.getState().addOutgoing({
            transferId, to: from, toName: peerName,
            fileInfo: { name: file.name, size: file.size, type: file.type },
            status: "queued", isBroadcast: true,
          });
        }
        // Enqueue — processBroadcastQueue manages the slot and increments counter
        _broadcastSendQueue.push({ from, transferId, peerName });
        processBroadcastQueue();
        return; // do NOT fall through to direct createOffer below
      }

      useStore.getState().updateOutgoing(transferId, { status: "accepted" });
      _activeTransferPeer[from] = transferId;
      await createOffer(transferId, from, peerName);
    });

    sock.on("file-rejected",  ({ transferId }) => { useStore.getState().updateOutgoing(transferId, { status: "rejected" }); cleanup(transferId); });
    sock.on("file-cancelled", ({ transferId }) => { useStore.getState().removeIncomingRequest(transferId); cleanup(transferId); });
    sock.on("transfer-busy",  ({ transferId }) => useStore.getState().updateOutgoing(transferId, { status: "queued" }));

    // Only receiver confirmation clears busy on both sides
    sock.on("transfer-complete", ({ transferId, role }) => {
      if (role === "receiver") useStore.getState().completeTransfer(transferId);
    });

    sock.on("leave-approved",      ()               => {
      clearSession();
      clearGuestSessionEnded();
      useStore.getState().reset();
      useStore.setState({ sessionEndedMsg: "You have left the room." });
    });
    sock.on("leave-denied",        ()               => useStore.setState({ leaveStatus: "denied" }));
    sock.on("guest-leave-request", ({ peerId, name }) => useStore.getState().addLeaveRequest({ peerId, name }));

    sock.on("signal", async ({ from, signal }) => {
      const { transferId } = signal;
      if (!transferId) return;
      try {
        if (signal.type === "offer") {
          const pc = buildPC(transferId, from);
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sock.emit("signal", { to: from, signal: { ...answer, transferId } });
        } else if (signal.type === "answer") {
          await _peerConns[transferId]?.setRemoteDescription(new RTCSessionDescription(signal));
        } else if (signal.candidate) {
          const c = signal.candidate;
          if (c && (c.sdpMid != null || c.sdpMLineIndex != null))
            await _peerConns[transferId]?.addIceCandidate(new RTCIceCandidate(c)).catch(e => console.warn("ICE:", e.message));
        }
      } catch (e) { console.error("Signal error:", e); }
    });

    return sock;
  }, []);

  const sendFileRequest = useCallback((toPeerId, toPeerName, file) => {
    const store = useStore.getState();
    const dup = (store.outgoingQueue ?? []).find(t =>
      t.to === toPeerId && t.fileInfo?.name === file.name &&
      t.fileInfo?.size === file.size && t.status !== "done"
    );
    if (dup) return;

    const transferId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    _pendFiles[transferId] = file;
    store.addOutgoing({ transferId, to: toPeerId, toName: toPeerName, fileInfo: { name: file.name, size: file.size, type: file.type }, status: "pending" });

    if (_activeTransferPeer[toPeerId]) {
      enqueueTransfer(toPeerId, transferId, file, toPeerName);
      store.updateOutgoing(transferId, { status: "queued" });
      return;
    }
    _socket?.emit("file-request", { to: toPeerId, transferId, fileInfo: { name: file.name, size: file.size, type: file.type } });
  }, []);

  const broadcastFile = useCallback((file) => {
    const transferId = `bc-${Date.now()}`;
    // Store in both: _pendFiles for the immediate send path, and _broadcastFiles
    // as a persistent registry so late joiners can always resolve the file.
    _pendFiles[`__broadcast__${transferId}`] = file;
    _broadcastFiles[transferId] = file;
    _socket?.emit("broadcast-file", { transferId, fileInfo: { name: file.name, size: file.size, type: file.type } });
  }, []);

  // acceptRequest: uses FSAPI streaming for large files on supported browsers,
  // otherwise falls back to memory path with partial blob flush.
  const acceptRequest = useCallback(async ({ transferId, from, fileInfo }) => {
    useStore.getState().removeIncomingRequest(transferId);

    // Try FSAPI streaming for large files
    if (fileInfo && fileInfo.size >= ENGINE.streamThreshold && ENGINE.hasFS) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: fileInfo.name,
          types: [{ description: "File", accept: { "*/*": [] } }],
        });
        const writable = await handle.createWritable();
        _streamWriters[transferId] = writable;
        console.log(`📂 Streaming save opened for ${fileInfo.name} (${(fileInfo.size / 1024 / 1024 / 1024).toFixed(2)} GB)`);
      } catch (err) {
        if (err.name !== "AbortError") console.warn("showSaveFilePicker failed:", err);
      }
    }

    _socket?.emit("file-accepted", { to: from, transferId });
  }, []);

  const rejectRequest  = useCallback(({ transferId, from }) => { useStore.getState().removeIncomingRequest(transferId); _socket?.emit("file-rejected", { to: from, transferId }); }, []);
  const cancelOutgoing = useCallback((transferId, to)       => {
    _socket?.emit("file-cancelled", { to, transferId });
    useStore.getState().removeOutgoing(transferId);
    cleanup(transferId);
    if (_queue[to]) _queue[to] = _queue[to].filter(t => t.transferId !== transferId);
  }, []);
  const kickPeer       = useCallback((peerId) => { _socket?.emit("kick-peer", { peerId }); clearPeerQueue(peerId); }, []);
  const requestLeave   = useCallback((ack)    => _socket?.emit("request-leave", {}, ack), []);
  const approveLeave   = useCallback((peerId) => _socket?.emit("approve-leave", { peerId }), []);
  const denyLeave      = useCallback((peerId) => _socket?.emit("deny-leave",    { peerId }), []);
  const endSession     = useCallback(() => {
    _socket?.emit("end-session");
    clearSession();
    clearGuestSessionEnded();
    useStore.getState().reset();
    useStore.setState({ sessionEndedMsg: "Session ended." });
    // Clear persistent broadcast registry and queue so memory is freed
    Object.keys(_broadcastFiles).forEach(k => delete _broadcastFiles[k]);
    _broadcastSendQueue.length = 0;
    _activeBroadcastCount = 0;
  }, []);
  const updateSettings = useCallback((patch)  => _socket?.emit("update-room-settings", patch), []);
  const approveHostCreate = useCallback((requestId) => _socket?.emit("approve-host-create", { requestId }), []);
  const denyHostCreate = useCallback((requestId) => _socket?.emit("deny-host-create", { requestId }), []);

  // createRoom — wraps create-room emit and handles the pendingApproval flow.
  // When networkHostApproverId is set on the server, the first attempt returns
  // { pendingApproval: true }. We store the params so the host-create-approved
  // handler can re-try automatically without the user doing anything.
  const createRoom = useCallback((roomId, name, device) => {
    useStore.setState({ hostCreateError: null });
    _socket?.emit("create-room", { roomId, name, device }, (res) => {
      if (res.pendingApproval) {
        // Store params for the approved handler to re-use
        useStore.setState({ pendingHostCreate: { roomId, name, device } });
        return;
      }
      if (res.error) {
        useStore.setState({ hostCreateError: res.error });
        return;
      }
      if (res.ok) {
        useStore.setState({
          role: "host", roomId, myName: name,
          myDevice: device, isHost: true,
          roomSettings: res.settings, pendingRoom: null,
          hostCreateError: null, pendingHostCreate: null,
        });
        saveSession({ name, device, token: res.token });
        if (!_socket) return;
        // Set networkHostApproverId on first successful creation
      }
    });
  }, []);

  return {
    initSocket, sendFileRequest, broadcastFile, acceptRequest, rejectRequest,
    cancelOutgoing, kickPeer, requestLeave, approveLeave, denyLeave,
    endSession, updateSettings, approveHostCreate, denyHostCreate, createRoom,
  };
}

export function resolveBroadcastFile(transferId) {
  if (_pendFiles[transferId]) return; // already resolved
  const m = transferId.match(/^(bc-\d+)__/);
  if (!m) return;
  const bcId = m[1];
  // Primary: persistent registry — always available even after original peers complete
  if (_broadcastFiles[bcId]) {
    _pendFiles[transferId] = _broadcastFiles[bcId];
    return;
  }
  // Fallback: legacy __broadcast__ key (for transfers before this fix)
  const legacyKey = `__broadcast__${bcId}`;
  if (_pendFiles[legacyKey]) _pendFiles[transferId] = _pendFiles[legacyKey];
}