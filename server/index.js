const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const cors       = require("cors");
const os         = require("os");
const QRCode     = require("qrcode");
const path       = require("path");

const PORT     = process.env.PORT || 3001;
const FRONTEND_PORT = 5173;
const IS_LOCAL = !process.env.PORT;
const MAX_USERNAME_LENGTH = 20;

const SUBNET_PRIORITY = [
  "192.168.43.", "172.20.10.", "192.168.137.",
  "192.168.1.",  "192.168.0.", "10.",
];

function getBestIP() {
  const ifaces = os.networkInterfaces();
  const all = [];
  for (const name of Object.keys(ifaces))
    for (const iface of ifaces[name])
      if (iface.family === "IPv4" && !iface.internal)
        all.push({ name, address: iface.address });
  for (const subnet of SUBNET_PRIORITY) {
    const match = all.find(c => c.address.startsWith(subnet));
    if (match) return match.address;
  }
  return all[0]?.address || "127.0.0.1";
}

function startTURN(ip) {
  try {
    const Turn = require("node-turn");
    new Turn({
      authMech: "long-term",
      credentials: { swiftdrop: "swiftpass" },
      listeningIps: [ip, "0.0.0.0"],
      listeningPort: 3478,
      relayIps: [ip],
      debugLevel: "OFF",
    }).start();
    console.log(`✅ TURN relay on ${ip}:3478`);
  } catch (e) { console.warn("TURN unavailable:", e.message); }
}

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e8,
});

app.use(cors());
app.use(express.json());

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "../client/dist")));

  app.get(/.*/, (_, res) =>
    res.sendFile(path.join(__dirname, "../client/dist/index.html"))
  );
}

const HOST_IP = getBestIP();

function defaultSettings() {
  return {
    allowGuestToGuest:      false,
    allowGuestToHost:       true,
    allowGuestLeave:        true,
    requireLeaveApproval:   false,
    allowLateJoin:          true,
    broadcastToLateJoiners: false,
    maxGuests:              50,
  };
}

const rooms         = {};
const sessionTokens = {};
let networkHostApproverId = null;
let networkHostApproverToken = null;
let networkHostApproverReleaseTimer = null;
const approvedHostCreators = {};      // socketId -> expiresAt
const pendingHostCreateRequests = {}; // requestId -> { requesterSocketId, name, ip, roomId, requestedAt }
const pendingHostCreateTimers = {};   // requestId -> timeout

// ─── Per-peer transfer queue tracking (server-side) ──────────────────────────
// Tracks active transferId per peerId so we can queue without blocking.
// Format: _peerActiveTransfer[socketId] = Set of active transferIds
const _peerActiveTransfers = {};

function setPeerBusy(socketId, transferId) {
  if (!_peerActiveTransfers[socketId]) _peerActiveTransfers[socketId] = new Set();
  _peerActiveTransfers[socketId].add(transferId);
}

function setPeerFree(socketId, transferId) {
  if (_peerActiveTransfers[socketId]) {
    _peerActiveTransfers[socketId].delete(transferId);
  }
}

function isPeerBusy(socketId) {
  return _peerActiveTransfers[socketId]?.size > 0;
}

// ─────────────────────────────────────────────────────────────────────────────

function makeToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getClientIp(socket) {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  const raw = (forwarded ? String(forwarded).split(",")[0] : socket.handshake.address) || "unknown";
  return raw.replace(/^::ffff:/, "");
}

function makeRequestId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function clearPendingHostCreateRequest(requestId) {
  if (pendingHostCreateTimers[requestId]) {
    clearTimeout(pendingHostCreateTimers[requestId]);
    delete pendingHostCreateTimers[requestId];
  }
  delete pendingHostCreateRequests[requestId];
}

function clearApproverReleaseTimer() {
  if (networkHostApproverReleaseTimer) {
    clearTimeout(networkHostApproverReleaseTimer);
    networkHostApproverReleaseTimer = null;
  }
}

function clearAllHostCreateApprovalState() {
  networkHostApproverId = null;
  networkHostApproverToken = null;
  clearApproverReleaseTimer();
  for (const requestId of Object.keys(pendingHostCreateRequests)) {
    clearPendingHostCreateRequest(requestId);
  }
  for (const socketId of Object.keys(approvedHostCreators)) {
    delete approvedHostCreators[socketId];
  }
}

function makeRoom(roomId, hostId, hostName, hostDevice) {
  const token = makeToken();
  sessionTokens[token] = { roomId, name: hostName, device: hostDevice, isHost: true };
  rooms[roomId] = {
    hostId,
    settings: defaultSettings(),
    broadcastHistory: [],
    peers: new Map([[hostId, {
      id: hostId, name: hostName, device: hostDevice,
      isHost: true, busy: false, joinedAt: Date.now(), token,
    }]]),
  };
  return token;
}

function getRoomPeerList(roomId) {
  if (!rooms[roomId]) return [];
  return Array.from(rooms[roomId].peers.values()).map(p => ({
    id: p.id, name: p.name, device: p.device, isHost: p.isHost, busy: p.busy,
  }));
}

function broadcastPeerList(roomId) {
  if (!rooms[roomId]) return;
  io.to(roomId).emit("peer-list", getRoomPeerList(roomId));
}

function broadcastSettings(roomId) {
  if (!rooms[roomId]) return;
  io.to(roomId).emit("room-settings", rooms[roomId].settings);
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);
  socket.data = {};

  socket.on("create-room", ({ roomId, name, device }, ack) => {
    const trimmedName = String(name || "").trim();
    if (socket.data?.roomId) { ack({ error: "Already in a room" }); return; }
    if (!roomId || !trimmedName) { ack({ error: "Invalid room parameters" }); return; }
    if (trimmedName.length > MAX_USERNAME_LENGTH) {
      ack({ error: `Name must be ${MAX_USERNAME_LENGTH} characters or fewer` });
      return;
    }

    // Fresh server with no active rooms should never block the first host.
    if (Object.keys(rooms).length === 0) {
      clearAllHostCreateApprovalState();
    }

    if (networkHostApproverId) {
      const approverSocket = io.sockets.sockets.get(networkHostApproverId);
      if (!approverSocket) {
        networkHostApproverId = null;
      }
    }

    if (!networkHostApproverId && networkHostApproverToken) {
      ack({ error: "Room-creation approver is offline. Wait for the original host to reconnect." });
      return;
    }

    if (networkHostApproverId && networkHostApproverId !== socket.id) {
      const approvalExpiry = approvedHostCreators[socket.id] || 0;
      if (approvalExpiry < Date.now()) {
        const requestId = makeRequestId();
        const req = {
          requestId,
          requesterSocketId: socket.id,
          name: trimmedName,
          ip: getClientIp(socket),
          roomId,
          requestedAt: Date.now(),
        };
        pendingHostCreateRequests[requestId] = req;
        io.to(networkHostApproverId).emit("host-create-request", {
          requestId: req.requestId,
          name: req.name,
          ip: req.ip,
          roomId: req.roomId,
          requestedAt: req.requestedAt,
        });
        pendingHostCreateTimers[requestId] = setTimeout(() => {
          const timedReq = pendingHostCreateRequests[requestId];
          if (!timedReq) return;
          io.to(timedReq.requesterSocketId).emit("host-create-denied", {
            requestId,
            message: "Host approval timed out. Please try again.",
          });
          clearPendingHostCreateRequest(requestId);
        }, 45000);
        ack({ pendingApproval: true });
        return;
      }
      delete approvedHostCreators[socket.id];
    }

    if (rooms[roomId]) { ack({ error: "Room already exists" }); return; }
    const token = makeRoom(roomId, socket.id, trimmedName, device);
    if (!networkHostApproverId) {
      clearApproverReleaseTimer();
      networkHostApproverId = socket.id;
      networkHostApproverToken = token;
    }
    socket.join(roomId);
    socket.data = { roomId, name: trimmedName, isHost: true, token };
    console.log(`Room created: ${roomId} by ${trimmedName}`);
    ack({ ok: true, roomId, token, settings: rooms[roomId].settings });
  });

  socket.on("approve-host-create", ({ requestId }) => {
    if (socket.id !== networkHostApproverId) return;
    const req = pendingHostCreateRequests[requestId];
    if (!req) return;
    approvedHostCreators[req.requesterSocketId] = Date.now() + 2 * 60 * 1000;
    io.to(req.requesterSocketId).emit("host-create-approved", {
      requestId,
      message: "Approved. You can now create your room.",
    });
    clearPendingHostCreateRequest(requestId);
  });

  socket.on("deny-host-create", ({ requestId }) => {
    if (socket.id !== networkHostApproverId) return;
    const req = pendingHostCreateRequests[requestId];
    if (!req) return;
    io.to(req.requesterSocketId).emit("host-create-denied", {
      requestId,
      message: "Host denied your request to create a room.",
    });
    clearPendingHostCreateRequest(requestId);
  });

  socket.on("join-room", ({ roomId, name, device }, ack) => {
    const trimmedName = String(name || "").trim();
    if (socket.data?.roomId) { ack({ error: "Already in a room" }); return; }
    if (!roomId || !trimmedName) { ack({ error: "Invalid join parameters" }); return; }
    if (trimmedName.length > MAX_USERNAME_LENGTH) {
      ack({ error: `Name must be ${MAX_USERNAME_LENGTH} characters or fewer` });
      return;
    }
    const room = rooms[roomId];
    if (!room) { ack({ error: "Room not found" }); return; }
    if (!room.settings.allowLateJoin && room.peers.size > 1) {
      ack({ error: "Host has locked the room — no new joins allowed" }); return;
    }
    if (room.peers.size > room.settings.maxGuests) {
      ack({ error: `Room is full (max ${room.settings.maxGuests})` }); return;
    }

    for (const [oldSocketId, peerData] of room.peers.entries()) {
      if (peerData.name === trimmedName && peerData.device === device) {
        room.peers.delete(oldSocketId);
      }
    }

    const token = makeToken();
    sessionTokens[token] = { roomId, name: trimmedName, device, isHost: false };
    room.peers.set(socket.id, {
      id: socket.id, name: trimmedName, device, isHost: false, busy: false, joinedAt: Date.now(), token,
    });
    socket.join(roomId);
    socket.data = { roomId, name: trimmedName, isHost: false, token };
    ack({ ok: true, hostId: room.hostId, peers: getRoomPeerList(roomId), token, settings: room.settings });
    broadcastPeerList(roomId);
    io.to(room.hostId).emit("guest-joined", { id: socket.id, name: trimmedName, device });
    console.log(`${trimmedName} joined room ${roomId}`);

    // ── Replay broadcasts to late joiner ──────────────────────────────────────
    // Case 1: In-flight broadcasts → always send (file is live in host's memory).
    // Case 2: Completed broadcasts → only send if broadcastToLateJoiners=true.
    const joinerSocketId = socket.id;
    setTimeout(() => {
      const r = rooms[roomId];
      if (!r || !r.peers.has(joinerSocketId)) return;

      // In-flight — unconditional
      Object.values(r.activeBroadcasts || {}).forEach(ab => {
        io.to(joinerSocketId).emit("file-request", {
          from: r.hostId, fromName: ab.fromName, fromDevice: ab.fromDevice,
          fileInfo: ab.fileInfo,
          transferId: `${ab.transferId}__${joinerSocketId}`,
          isBroadcast: true,
        });
        ab.pendingPeers.add(joinerSocketId);
      });
      const activeCount = Object.keys(r.activeBroadcasts || {}).length;
      if (activeCount > 0)
        console.log(`📡 Sent ${activeCount} in-flight broadcast(s) to late joiner ${trimmedName}`);

      // Completed history — only if setting enabled, skip already-active ones
      if (r.settings.broadcastToLateJoiners && r.broadcastHistory?.length > 0) {
        const activeIds = new Set(Object.keys(r.activeBroadcasts || {}));
        const toReplay = r.broadcastHistory.filter(bc => !activeIds.has(bc.transferId));
        toReplay.forEach(bc => {
          io.to(joinerSocketId).emit("file-request", {
            from: r.hostId, fromName: bc.fromName, fromDevice: bc.fromDevice,
            fileInfo: bc.fileInfo,
            transferId: `${bc.transferId}__${joinerSocketId}`,
            isBroadcast: true,
          });
        });
        if (toReplay.length > 0)
          console.log(`📡 Replayed ${toReplay.length} completed broadcast(s) to late joiner ${trimmedName}`);
      }
    }, 1500);
  });

  socket.on("rejoin-room", ({ token }, ack) => {
    const sess = sessionTokens[token];
    if (!sess) { ack({ error: "Session expired or invalid" }); return; }
    const room = rooms[sess.roomId];
    if (!room)  { ack({ error: "Room no longer exists" }); return; }

    for (const [oldSocketId, peerData] of room.peers.entries()) {
      if (peerData.token === token) {
        room.peers.delete(oldSocketId);
        break;
      }
    }

    const newToken = makeToken();
    sessionTokens[newToken] = { ...sess };
    delete sessionTokens[token];

    if (sess.isHost) {
      room.hostId = socket.id;
      if (networkHostApproverToken && networkHostApproverToken === token) {
        clearApproverReleaseTimer();
        networkHostApproverId = socket.id;
        networkHostApproverToken = newToken;
      }
    }

    room.peers.set(socket.id, {
      id: socket.id, name: sess.name, device: sess.device,
      isHost: sess.isHost, busy: false, joinedAt: Date.now(), token: newToken,
    });
    socket.join(sess.roomId);
    socket.data = { roomId: sess.roomId, name: sess.name, isHost: sess.isHost, token: newToken };

    ack({ ok: true, roomId: sess.roomId, hostId: room.hostId, isHost: sess.isHost,
      peers: getRoomPeerList(sess.roomId), token: newToken, settings: room.settings });
    broadcastPeerList(sess.roomId);
    console.log(`${sess.name} rejoined room ${sess.roomId}`);

    // Send in-flight broadcasts to rejoining guest
    if (!sess.isHost && Object.keys(room.activeBroadcasts || {}).length > 0) {
      const rejoinerSocketId = socket.id;
      setTimeout(() => {
        const r = rooms[sess.roomId];
        if (!r || !r.peers.has(rejoinerSocketId)) return;
        Object.values(r.activeBroadcasts || {}).forEach(ab => {
          io.to(rejoinerSocketId).emit("file-request", {
            from: r.hostId, fromName: ab.fromName, fromDevice: ab.fromDevice,
            fileInfo: ab.fileInfo,
            transferId: `${ab.transferId}__${rejoinerSocketId}`,
            isBroadcast: true,
          });
          ab.pendingPeers.add(rejoinerSocketId);
        });
        console.log(`📡 Sent ${Object.keys(r.activeBroadcasts || {}).length} in-flight broadcast(s) to rejoiner ${sess.name}`);
      }, 1500);
    }
  });

  socket.on("update-room-settings", (patch) => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) return;
    room.settings = { ...room.settings, ...patch };
    broadcastSettings(roomId);
    console.log(`Settings updated in ${roomId}:`, patch);
  });

  socket.on("signal", ({ to, signal }) => {
    const room = rooms[socket.data?.roomId];
    if (!room || !room.peers.has(to)) return;
    io.to(to).emit("signal", { from: socket.id, signal });
  });

  socket.on("file-request", ({ to, fileInfo, transferId, fromQueue }) => {
    const room = rooms[socket.data?.roomId];
    if (!room) return;
    const sender   = room.peers.get(socket.id);
    const receiver = room.peers.get(to);
    if (!sender || !receiver) return;

    const s = room.settings;
    if (!sender.isHost && receiver.isHost && !s.allowGuestToHost) {
      socket.emit("transfer-denied", { transferId, reason: "Host has disabled receiving files from guests" });
      return;
    }
    if (!sender.isHost && !receiver.isHost && !s.allowGuestToGuest) {
      socket.emit("transfer-denied", { transferId, reason: "Host has disabled guest-to-guest transfers" });
      return;
    }

    // ✅ FIX: Never hard-block with "busy" — just forward the request.
    // The queue is managed on the client side. The busy flag is now only
    // cosmetic for the peer list UI, not a gate for transfers.
    io.to(to).emit("file-request", {
      from: socket.id, fromName: sender.name, fromDevice: sender.device,
      fileInfo, transferId, fromQueue: !!fromQueue,
    });
    console.log(`File request: ${sender.name} → ${receiver.name} [${fileInfo.name}]${fromQueue ? " (queued)" : ""}`);
  });

  socket.on("broadcast-file", ({ fileInfo, transferId }) => {
    const room = rooms[socket.data?.roomId];
    if (!room || room.hostId !== socket.id) return;
    const sender = room.peers.get(socket.id);

    // Store for late joiners (only broadcast metadata, not the file itself)
    if (!room.broadcastHistory) room.broadcastHistory = [];
    room.broadcastHistory.push({
      transferId, fileInfo,
      fromName: sender.name, fromDevice: sender.device,
    });

    // Track in-flight so guests joining DURING this broadcast get it immediately
    if (!room.activeBroadcasts) room.activeBroadcasts = {};
    const recipientSet = new Set();
    room.peers.forEach((_, peerId) => { if (peerId !== socket.id) recipientSet.add(peerId); });
    room.activeBroadcasts[transferId] = {
      transferId, fileInfo,
      fromName: sender.name, fromDevice: sender.device,
      pendingPeers: recipientSet,
    };

    let count = 0;
    room.peers.forEach((peer, peerId) => {
      if (peerId === socket.id) return;
      io.to(peerId).emit("file-request", {
        from: socket.id, fromName: sender.name, fromDevice: sender.device,
        fileInfo, transferId: `${transferId}__${peerId}`, isBroadcast: true,
      });
      count++;
    });
    socket.emit("broadcast-sent", { count, transferId });
  });

  socket.on("file-accepted", ({ to, transferId }) => {
    const room = rooms[socket.data?.roomId];
    if (!room) return;
    const receiver = room.peers.get(socket.id);
    const sender   = room.peers.get(to);

    // Mark busy for peer list display only
    if (receiver) receiver.busy = true;
    if (sender)   sender.busy   = true;

    // Track active transfer server-side
    setPeerBusy(socket.id, transferId);
    setPeerBusy(to, transferId);

    io.to(to).emit("file-accepted", { from: socket.id, transferId });
    broadcastPeerList(socket.data.roomId);
  });

  socket.on("file-rejected",  ({ to, transferId }) => io.to(to).emit("file-rejected",  { from: socket.id, transferId }));
  socket.on("file-cancelled", ({ to, transferId }) => io.to(to).emit("file-cancelled", { from: socket.id, transferId }));

  // ✅ FIX: Only clear busy + relay to UI when RECEIVER confirms completion.
  // Sender emits role:"sender" (buffer flushed but receiver may still be assembling).
  // Receiver emits role:"receiver" (actual download triggered) — this is the real done.
  socket.on("transfer-complete", ({ peerId, transferId, role }) => {
    const room = rooms[socket.data?.roomId];
    if (!room) return;

    if (role === "receiver") {
      // Real completion — clear this transfer from busy tracking
      setPeerFree(socket.id, transferId);
      setPeerFree(peerId, transferId);

      // Only set busy=false if the peer has NO other active transfers
      // (critical for broadcasts where the host has 20 transfers in flight)
      const self  = room.peers.get(socket.id);
      const other = room.peers.get(peerId);
      if (self)  self.busy  = isPeerBusy(socket.id);
      if (other) other.busy = isPeerBusy(peerId);

      // Tell the sender's UI the transfer is done
      io.to(peerId).emit("transfer-complete", { from: socket.id, transferId, role: "receiver" });
      broadcastPeerList(socket.data.roomId);
      console.log(`✅ Transfer complete (receiver confirmed): ${transferId}`);

      // Decrement active broadcast tracking
      const bcMatch = transferId.match(/^(bc-\d+)__/);
      if (bcMatch && room.activeBroadcasts?.[bcMatch[1]]) {
        const ab = room.activeBroadcasts[bcMatch[1]];
        ab.pendingPeers.delete(socket.id);
        if (ab.pendingPeers.size === 0) {
          delete room.activeBroadcasts[bcMatch[1]];
          console.log(`📡 Broadcast ${bcMatch[1]} fully delivered`);
        }
      }
    } else {
      // Sender side flush complete — just log, don't clear busy yet
      console.log(`📤 Sender flushed: ${transferId} (waiting for receiver ack)`);
    }
  });

  socket.on("request-leave", (_, ack) => {
    const room = rooms[socket.data?.roomId];
    if (!room) { if (ack) ack({ ok: true }); return; }
    const s = room.settings;
    if (s.allowGuestLeave && !s.requireLeaveApproval) {
      if (ack) ack({ ok: true });
      doLeave(socket, socket.data.roomId);
    } else {
      io.to(room.hostId).emit("guest-leave-request", { peerId: socket.id, name: socket.data.name });
      if (ack) ack({ pending: true });
    }
  });

  socket.on("approve-leave", ({ peerId }) => {
    const room = rooms[socket.data?.roomId];
    if (!room || room.hostId !== socket.id) return;
    const peerSocket = io.sockets.sockets.get(peerId);
    if (peerSocket) { peerSocket.emit("leave-approved"); doLeave(peerSocket, socket.data.roomId); }
  });

  socket.on("deny-leave", ({ peerId }) => io.to(peerId).emit("leave-denied"));

  socket.on("kick-peer", ({ peerId }) => {
    const room = rooms[socket.data?.roomId];
    if (!room || room.hostId !== socket.id) return;
    io.to(peerId).emit("kicked");
    const ps = io.sockets.sockets.get(peerId);
    if (ps) doLeave(ps, socket.data.roomId);
    // Clean up server-side busy tracking
    delete _peerActiveTransfers[peerId];
  });

  socket.on("end-session", () => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) return;
    io.to(roomId).emit("session-ended");
    for (const [t, s] of Object.entries(sessionTokens))
      if (s.roomId === roomId) delete sessionTokens[t];
    delete rooms[roomId];
    console.log(`Room ${roomId} ended`);
  });

  socket.on("disconnect", () => {
    const { roomId } = socket.data || {};

    if (socket.id === networkHostApproverId) {
      networkHostApproverId = null;
      clearApproverReleaseTimer();
      networkHostApproverReleaseTimer = setTimeout(() => {
        if (!networkHostApproverId) networkHostApproverToken = null;
        networkHostApproverReleaseTimer = null;
      }, 30000);
      for (const [requestId, req] of Object.entries(pendingHostCreateRequests)) {
        io.to(req.requesterSocketId).emit("host-create-denied", {
          requestId,
          message: "Approval host disconnected. Please try again.",
        });
        clearPendingHostCreateRequest(requestId);
      }
    }
    delete approvedHostCreators[socket.id];
    for (const [requestId, req] of Object.entries(pendingHostCreateRequests)) {
      if (req.requesterSocketId === socket.id) clearPendingHostCreateRequest(requestId);
    }

    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];

    // Clean up busy tracking on disconnect
    delete _peerActiveTransfers[socket.id];

    if (socket.id === room.hostId) {
      setTimeout(() => {
        if (rooms[roomId] && rooms[roomId].hostId === socket.id) {
          io.to(roomId).emit("session-ended");
          for (const [t, s] of Object.entries(sessionTokens))
            if (s.roomId === roomId) delete sessionTokens[t];
          delete rooms[roomId];
          console.log(`Room ${roomId} ended — host timed out`);
        }
      }, 30000);
    } else {
      io.to(room.hostId).emit("guest-disconnected", { id: socket.id, name: socket.data.name });
      setTimeout(() => {
        const r = rooms[roomId];
        if (r && r.peers.has(socket.id)) {
          r.peers.delete(socket.id);
          broadcastPeerList(roomId);
          io.to(room.hostId).emit("guest-left", { id: socket.id });
        }
      }, 15000);
    }
    console.log("Disconnected:", socket.id);
  });
});

function doLeave(socket, roomId) {
  if (!socket || !rooms[roomId]) return;
  const room = rooms[roomId];
  const peer = room.peers.get(socket.id);
  if (peer) { delete sessionTokens[peer.token]; room.peers.delete(socket.id); }
  delete _peerActiveTransfers[socket.id];
  socket.leave(roomId);
  socket.data.roomId = null;
  broadcastPeerList(roomId);
}

app.get("/api/server-info", async (req, res) => {
  const url = IS_LOCAL ? `http://${HOST_IP}:${FRONTEND_PORT}` : `https://${req.headers.host}`;
  const qr  = await QRCode.toDataURL(url, { width: 280, margin: 2, color: { dark: "#22c55e", light: "#0a0a0f" } });
  res.json({ ip: HOST_IP, port: PORT, url, qr, isLocal: IS_LOCAL,
    turnIp: HOST_IP, turnPort: 3478, turnUser: "swiftdrop", turnPass: "swiftpass" });
});

app.get("/api/room-qr/:roomId", async (req, res) => {
  const base = IS_LOCAL ? `http://${HOST_IP}:${FRONTEND_PORT}` : `https://${req.headers.host}`;
  const url  = `${base}?room=${req.params.roomId}`;
  const qr   = await QRCode.toDataURL(url, { width: 280, margin: 2, color: { dark: "#22c55e", light: "#0a0a0f" } });
  res.json({ url, qr });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 SwiftDrop on http://0.0.0.0:${PORT}`);
  console.log(`📡 LAN IP: ${HOST_IP}\n`);
  if (IS_LOCAL) startTURN(HOST_IP);
});