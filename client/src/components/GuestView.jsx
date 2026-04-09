import { useState, useRef } from "react";
import { useStore } from "../store";
import { useSwiftDrop, clearSession } from "../hooks/useSwiftDrop";
import RequestCard from "./RequestCard";
import TransferQueue from "./TransferQueue";

function fmtSize(b) {
  if (b > 1e9) return (b / 1e9).toFixed(2) + " GB";
  if (b > 1e6) return (b / 1e6).toFixed(2) + " MB";
  if (b > 1e3) return (b / 1e3).toFixed(1) + " KB";
  return b + " B";
}

function fileIcon(name = "") {
  const ext = name.split(".").pop().toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "🖼️";
  if (["mp4", "mov", "avi", "mkv"].includes(ext)) return "🎬";
  if (["mp3", "wav", "flac"].includes(ext)) return "🎵";
  if (["pdf"].includes(ext)) return "📄";
  if (["zip", "rar", "7z"].includes(ext)) return "📦";
  return "📁";
}

export default function GuestView() {
  const { peers, roomId, hostId, incomingRequests, activeTransfers, outgoingQueue, completedTransfers, roomSettings, leaveStatus } = useStore();
  const { acceptRequest, rejectRequest, sendFileRequest, cancelOutgoing, requestLeave } = useSwiftDrop();

  const [selectedTarget, setSelectedTarget] = useState(null);
  const [leaveLoading, setLeaveLoading] = useState(false);
  const fileRef = useRef();
  const hostFileRef = useRef();

  const mySocketId = window._swiftSock?.id;
  const host = peers.find(p => p.isHost);
  const otherGuests = peers.filter(p => !p.isHost && p.id !== mySocketId);
  const allPeers = peers;

  const topRequest = incomingRequests[0] || null;
  const queuedCount = incomingRequests.length > 0 ? incomingRequests.length - 1 : 0;

  const activeEntries = Object.entries(activeTransfers);
  const activeSending = activeEntries.filter(([, t]) => t.direction === "sending");
  const activeReceiving = activeEntries.filter(([, t]) => t.direction === "receiving");

  const completedSent = completedTransfers.filter(c => c.direction === "sending");
  const completedReceived = completedTransfers.filter(c => c.direction === "receiving");

  const handleSendTo = (peerId, peerName, file) => {
    if (!file) return;
    sendFileRequest(peerId, peerName, file);
  };

  const handleLeave = () => {
    setLeaveLoading(true);
    requestLeave((res) => {
      setLeaveLoading(false);
      if (res.ok) {
        clearSession();
        useStore.getState().reset();
        window.location.href = "/";
      } else if (res.pending) {
        useStore.setState({ leaveStatus: "pending" });
      }
    });
  };

  return (
    <div className="guest-layout">

      {/* HEADER */}
      <header className="guest-header">
        <div className="app-logo small">
          <span className="logo-icon">⚡</span>
          <div>
            <div className="logo-name">SwiftDrop</div>
            <div className="logo-sub">P2P File Sharing</div>
          </div>
        </div>

        <button className="leave-btn" onClick={handleLeave} disabled={leaveLoading || leaveStatus === "pending"}>
          {leaveStatus === "pending" ? "Awaiting approval..." : leaveLoading ? "..." : "Leave"}
        </button>
      </header>

      <div className="guest-content">

        {/* 🔵 PERMISSION BAR */}
        {roomSettings && (
          <div className="permission-notices" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {roomSettings.allowGuestToHost === false && (
              <div className="notice-bar info">
                🔒 Guest to Host sharing is disabled
              </div>
            )}
            {roomSettings.allowGuestToGuest === false && (
              <div className="notice-bar info">
                🔒 Guest to Guest sharing is disabled
              </div>
            )}
          </div>
        )}

        {/* ⚠️ LEAVE DENIED */}
        {leaveStatus === "denied" && (
          <div className="notice-bar warn">
            ⚠️ Host denied your leave request
            <button onClick={() => useStore.setState({ leaveStatus: null })}>✕</button>
          </div>
        )}

        {/* 📦 ROOM INFO (ALWAYS TOP) */}
        <div className="connection-card">
          <div className="conn-row">
            <span className="dot green" />
            <span>Room <strong>{roomId}</strong></span>
          </div>
          {host && <div className="host-info">Host: <strong>{host.name}</strong></div>}
        </div>

        {/* 👥 DEVICES */}
        <div className="devices-section">
          <div className="section-label">Devices</div>
          <div className="devices-grid">
            {allPeers.map(p => (
              <div key={p.id} className={`device-chip ${p.isHost ? "host" : ""}`}>
                {p.device === "phone" ? "📱" : "💻"} {p.name}
              </div>
            ))}
          </div>
        </div>

        {/* 📤 SEND TO HOST */}
        {host && roomSettings?.allowGuestToHost !== false && (
          <div className="send-section">
            <div className="section-label">Send to Host</div>
            <div className="drop-zone" onClick={() => hostFileRef.current.click()}>
              <input
                type="file"
                ref={hostFileRef}
                style={{ display: "none" }}
                onChange={e => {
                  handleSendTo(hostId, host.name, e.target.files[0]);
                  e.target.value = "";
                }}
              />
              <div className="drop-icon-big">📤</div>
              <div>Send to <strong>{host.name}</strong></div>
            </div>
          </div>
        )}

        {/* 📤 SEND TO GUEST */}
        {otherGuests.length > 0 && roomSettings?.allowGuestToGuest === true && (
          <div className="send-section">
            <div className="section-label">Send to Guest</div>

            <div className="guest-target-list">
              {otherGuests.map(g => (
                <button
                  key={g.id}
                  className={`guest-target-btn ${selectedTarget?.id === g.id ? "active" : ""}`}
                  onClick={() => {
                    setSelectedTarget(g);
                    fileRef.current?.click();
                  }}
                >
                  {g.device === "phone" ? "📱" : "💻"} {g.name}
                </button>
              ))}
            </div>

            <input
              type="file"
              ref={fileRef}
              style={{ display: "none" }}
              onChange={e => {
                if (selectedTarget && e.target.files[0]) {
                  handleSendTo(selectedTarget.id, selectedTarget.name, e.target.files[0]);
                }
                e.target.value = "";
              }}
            />
          </div>
        )}

        {/* 📥 REQUEST */}
        {topRequest && (
          <div className="request-section">
            <div className="section-label">
              Incoming Request {queuedCount > 0 && <span className="badge">{queuedCount} more</span>}
            </div>
            <RequestCard request={topRequest} onAccept={() => acceptRequest(topRequest)} onReject={() => rejectRequest(topRequest)} fileIcon={fileIcon} fmtSize={fmtSize}/>
          </div>
        )}

        {/* 📥 INBOX */}
        {(activeReceiving.length > 0 || completedReceived.length > 0) && (
          <div className="transfer-section">
            <div className="section-label">📥 Inbox</div>
            <TransferQueue active={activeReceiving} outgoing={[]} completed={completedReceived} fileIcon={fileIcon}/>
          </div>
        )}

        {/* 📤 OUTBOX */}
        {(activeSending.length > 0 || outgoingQueue.length > 0 || completedSent.length > 0) && (
          <div className="transfer-section">
            <div className="section-label">📤 Outbox</div>
            <TransferQueue active={activeSending} outgoing={outgoingQueue} completed={completedSent} onCancel={cancelOutgoing} fileIcon={fileIcon}/>
          </div>
        )}



      </div>
    </div>
  );
}