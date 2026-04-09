import { useState, useRef, useEffect } from "react";
import { useStore } from "../store";
import { useSwiftDrop } from "../hooks/useSwiftDrop";
import RequestCard from "./RequestCard";
import TransferQueue from "./TransferQueue";
import PeerCard from "./PeerCard";
import BroadcastModal from "./BroadcastModal";

function fileIcon(name = "") {
  const ext = name.split(".").pop().toLowerCase();
  if (["jpg","jpeg","png","gif","webp","svg"].includes(ext)) return "🖼️";
  if (["mp4","mov","avi","mkv","webm"].includes(ext))        return "🎬";
  if (["mp3","wav","flac","aac"].includes(ext))              return "🎵";
  if (["pdf"].includes(ext))                                 return "📄";
  if (["zip","rar","7z","tar","gz"].includes(ext))           return "📦";
  if (["doc","docx"].includes(ext))                          return "📝";
  if (["xls","xlsx","csv"].includes(ext))                    return "📊";
  return "📁";
}

function fmtSize(b) {
  if (b > 1e9) return (b / 1e9).toFixed(2) + " GB";
  if (b > 1e6) return (b / 1e6).toFixed(2) + " MB";
  if (b > 1e3) return (b / 1e3).toFixed(1) + " KB";
  return b + " B";
}

function Toggle({ checked, onChange, label, hint }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <span className="setting-label">{label}</span>
        {hint && <span className="setting-hint">{hint}</span>}
      </div>
      <label className="toggle">
        <input type="checkbox" checked={checked} onChange={onChange} />
        <span className="toggle-track">
          <span className="toggle-thumb" style={{ left: checked ? "22px" : "3px" }} />
        </span>
      </label>
    </div>
  );
}

export default function HostView() {
  const {
    peers, roomId, myName, activeTransfers, outgoingQueue, completedTransfers,
    roomSettings, leaveRequests, removeLeaveRequest, incomingRequests,
  } = useStore();
  const {
    sendFileRequest, broadcastFile, kickPeer, endSession,
    updateSettings, approveLeave, denyLeave, acceptRequest, rejectRequest,
  } = useSwiftDrop();

  const [selectedPeer,  setSelectedPeer]  = useState(null);
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [showSettings,  setShowSettings]  = useState(false);
  const [dragOver,      setDragOver]      = useState(false);
  const [roomQR,        setRoomQR]        = useState(null);
  const [roomUrl,       setRoomUrl]       = useState(null);
  const [copied,        setCopied]        = useState(false);
  const fileRef     = useRef();
  const settingsRef = useRef();

  useEffect(() => {
    if (!roomId) return;
    fetch(`/api/room-qr/${roomId}`)
      .then(r => r.json())
      .then(d => { setRoomQR(d.qr); setRoomUrl(d.url); })
      .catch(() => {});
  }, [roomId]);

  // Clear selected peer if they leave
  useEffect(() => {
    if (selectedPeer && !peers.find(p => p.id === selectedPeer.id)) setSelectedPeer(null);
  }, [peers]);

  // Keep selectedPeer in sync with latest peer data (busy, name…)
  useEffect(() => {
    if (selectedPeer) {
      const updated = peers.find(p => p.id === selectedPeer.id);
      if (updated) setSelectedPeer(updated);
    }
  }, [peers]);

  // Close settings panel on outside click
  // Use stopPropagation on the panel itself instead of DOM-detach detection —
  // that approach fails because mousedown fires BEFORE onChange/re-render detaches the node.
  useEffect(() => {
    const handler = (e) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target)) {
        setShowSettings(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const guests = peers.filter(p => !p.isHost);

  const handleFile = (file) => {
    if (!file) return;
    if (!selectedPeer) { alert("Select a device first"); return; }
    sendFileRequest(selectedPeer.id, selectedPeer.name, file);
  };

  const copyUrl = () => {
    navigator.clipboard.writeText(roomUrl || "").then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    });
  };

  // Optimistic update: apply locally immediately so the toggle responds without
  // waiting for the server round-trip echo (which also re-renders all 3+ guests).
  const { setRoomSettings } = useStore.getState();
  const patchSetting = (key, val) => {
    setRoomSettings({ ...roomSettings, [key]: val });
    updateSettings({ [key]: val });
  };

  // Split transfers by direction for selected peer
  const peerActive        = selectedPeer ? Object.entries(activeTransfers).filter(([, t]) => t.peerId === selectedPeer.id) : [];
  const peerActiveSending = peerActive.filter(([, t]) => t.direction === "sending");
  const peerActiveRecv    = peerActive.filter(([, t]) => t.direction === "receiving");
  const peerOutgoing      = selectedPeer ? outgoingQueue.filter(o => o.to === selectedPeer.id) : [];
  const peerCompleted     = selectedPeer ? completedTransfers.filter(c => c.peerName === selectedPeer.name) : [];
  const peerCompletedSent = peerCompleted.filter(c => c.direction === "sending");
  const peerCompletedRecv = peerCompleted.filter(c => c.direction === "receiving");

  return (
    <div className="main-layout">

      {/* ── Sidebar ──────────────────────────────────────────────── */}
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="app-logo small">
            <div className="logo-icon">⚡</div>
            <div><div className="logo-name">SwiftDrop</div><div className="logo-sub">P2P File Sharing</div></div>
          </div>
        </div>

        {/* ✅ FIX: Leave request banners inside sidebar — no more layout overlap */}
        {leaveRequests.length > 0 && (
          <div className="leave-requests-sidebar">
            {leaveRequests.map(req => (
              <div key={req.peerId} className="leave-banner-sidebar">
                <div className="leave-banner-msg">
                  <strong>{req.name}</strong> wants to leave
                </div>
                <div className="leave-banner-actions">
                  <button
                    className="btn-accept-sm"
                    onClick={() => { approveLeave(req.peerId); removeLeaveRequest(req.peerId); }}
                  >Allow</button>
                  <button
                    className="btn-reject-sm"
                    onClick={() => { denyLeave(req.peerId); removeLeaveRequest(req.peerId); }}
                  >Deny</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="room-info">
          <div className="room-row">
            <span className="dot green" />
            <span className="room-label">Room <strong>{roomId}</strong></span>
          </div>
          {roomQR && <img src={roomQR} alt="QR" className="qr-small" />}
          {roomUrl && (
            <div className="room-url-row">
              <span className="room-url">{roomUrl}</span>
              <button className="copy-btn" onClick={copyUrl}>{copied ? "✓" : "⧉"}</button>
            </div>
          )}
        </div>

        <div className="section-label">Devices <span className="badge">{guests.length}</span></div>

        <div className="peer-list">
          {guests.length === 0
            ? <div className="empty-peers">Waiting for guests…<br />Share QR or Room ID</div>
            : guests.map(peer => (
              <PeerCard
                key={peer.id} peer={peer}
                selected={selectedPeer?.id === peer.id}
                onClick={() => setSelectedPeer(peer)}
                onKick={() => kickPeer(peer.id)}
                activeTransfer={Object.values(activeTransfers).find(t => t.peerId === peer.id)}
              />
            ))
          }
        </div>

        <div className="sidebar-actions">
          <button className="btn-broadcast" onClick={() => setShowBroadcast(true)} disabled={guests.length === 0}>
            📡 Broadcast to All
          </button>
          <button className="btn-end" onClick={() => {
            if (window.confirm("End session for all devices?")) endSession();
          }}>
            End Session
          </button>
        </div>
      </aside>

      {/* ── Main ─────────────────────────────────────────────────── */}
      <main className="main-content">

        {/* Incoming file requests (guests sending to host) */}
        {incomingRequests.length > 0 && (
          <div className="request-section">
            <div className="section-label">Incoming Files ({incomingRequests.length})</div>
            {incomingRequests.map(req => (
              <RequestCard
                key={req.transferId} request={req}
                onAccept={() => acceptRequest(req)}
                onReject={() => rejectRequest(req)}
                fmtSize={fmtSize} fileIcon={fileIcon}
              />
            ))}
          </div>
        )}

        {/* Top bar */}
        <div className="top-bar">
          <div className="top-bar-left">
            <span className="dot green" />
            Hosting as <strong>{myName}</strong>
          </div>
          <div className="top-bar-right">
            {selectedPeer && (
              <span className="selected-label">
                → {selectedPeer.name}
                {selectedPeer.busy && <span className="busy-pill">BUSY</span>}
              </span>
            )}
            <div className="settings-wrap" ref={settingsRef}>
              <button className="settings-btn" onClick={() => setShowSettings(s => !s)} title="Room Settings">⚙️</button>
              {showSettings && (
                <div className="settings-panel" onMouseDown={e => e.stopPropagation()}>
                  <div className="settings-title">Room Settings</div>

                  <div className="settings-section-label">File Sharing</div>
                  <Toggle checked={roomSettings.allowGuestToHost}
                    onChange={e => patchSetting("allowGuestToHost", e.target.checked)}
                    label="Guests → Host" hint="Allow guests to send files to you" />
                  <Toggle checked={roomSettings.allowGuestToGuest}
                    onChange={e => patchSetting("allowGuestToGuest", e.target.checked)}
                    label="Guest ↔ Guest" hint="Allow guests to send files to each other" />

                  <div className="settings-section-label">Room Access</div>
                  <Toggle checked={roomSettings.allowLateJoin}
                    onChange={e => patchSetting("allowLateJoin", e.target.checked)}
                    label="Allow Late Join" hint="New guests can join after session starts" />
                  <Toggle checked={roomSettings.allowGuestLeave}
                    onChange={e => patchSetting("allowGuestLeave", e.target.checked)}
                    label="Free Leave" hint="Guests can leave without approval" />
                  <Toggle checked={roomSettings.requireLeaveApproval}
                    onChange={e => patchSetting("requireLeaveApproval", e.target.checked)}
                    label="Require Leave Approval" hint="You must approve every leave request" />
                </div>
              )}
            </div>
          </div>
        </div>

        {!selectedPeer ? (
          <div className="select-prompt">
            <div className="select-icon">👈</div>
            <div>Select a device to send files</div>
            {guests.length === 0 && <div className="hint">Room ID: <strong>{roomId}</strong></div>}
          </div>
        ) : (
          <div className="transfer-area">

            {/* Drop zone — always clickable, queues automatically when busy */}
            <div
              className={`drop-zone ${dragOver ? "over" : ""}`}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
              onClick={() => fileRef.current.click()}
            >
              <input type="file" ref={fileRef} style={{ display: "none" }}
                onChange={e => { handleFile(e.target.files[0]); e.target.value = ""; }} />
              <div className="drop-icon-big">📁</div>
              <div>Drop or click to send to <strong>{selectedPeer.name}</strong></div>
              {selectedPeer.busy && (
                <div className="queue-notice">⏳ Currently busy — file will be queued automatically</div>
              )}
            </div>

            {/* Inbox — files received from this peer */}
            {(peerActiveRecv.length > 0 || peerCompletedRecv.length > 0) && (
              <div className="transfer-section inbox-section">
                <div className="section-label">📥 Inbox (from {selectedPeer.name})</div>
                <TransferQueue
                  active={peerActiveRecv} outgoing={[]} completed={peerCompletedRecv}
                  fmtSize={fmtSize} fileIcon={fileIcon}
                />
              </div>
            )}

            {/* Outbox — files sent to this peer */}
            {(peerActiveSending.length > 0 || peerOutgoing.length > 0 || peerCompletedSent.length > 0) && (
              <div className="transfer-section outbox-section">
                <div className="section-label">📤 Outbox (to {selectedPeer.name})</div>
                <TransferQueue
                  active={peerActiveSending} outgoing={peerOutgoing} completed={peerCompletedSent}
                  fmtSize={fmtSize} fileIcon={fileIcon}
                  onCancel={(tid) => { _socket?.emit("file-cancelled", { to: selectedPeer.id, transferId: tid }); useStore.getState().removeOutgoing(tid); }}
                />
              </div>
            )}

          </div>
        )}
      </main>

      {showBroadcast && (
        <BroadcastModal
          peers={guests}
          onSend={f => { broadcastFile(f); setShowBroadcast(false); }}
          onClose={() => setShowBroadcast(false)}
        />
      )}
    </div>
  );
}
