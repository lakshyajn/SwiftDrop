import { useState, useRef } from "react";
import { useStore } from "../store";
import { useSwiftDrop, clearSession, clearGuestSessionEnded } from "../hooks/useSwiftDrop";
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
  const { peers, roomId, hostId, myName, incomingRequests, activeTransfers, outgoingQueue, completedTransfers, roomSettings, leaveStatus, sessionEndedMsg, theme, setTheme } = useStore();
  const { acceptRequest, rejectRequest, sendFileRequest, cancelOutgoing, requestLeave } = useSwiftDrop();

  const [selectedTarget, setSelectedTarget] = useState(null);
  const [leaveLoading, setLeaveLoading] = useState(false);
  const fileRef = useRef();
  const folderRef = useRef();
  const hostFileRef = useRef();
  const hostFolderRef = useRef();

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
  const nextTheme = theme === "dark" ? "light" : "dark";

  const handleSendTo = (peerId, peerName, file) => {
    if (!file) return;
    sendFileRequest(peerId, peerName, file);
  };

  const handleFolderSendTo = (peerId, peerName, files) => {
    const allFiles = Array.from(files || []);
    if (allFiles.length === 0) return;

    allFiles.forEach((file) => {
      const relativePath = file.webkitRelativePath || file.name;
      const normalizedName = relativePath.replace(/^\/+/, "");
      const namedFile = normalizedName === file.name
        ? file
        : new File([file], normalizedName, { type: file.type, lastModified: file.lastModified });
      sendFileRequest(peerId, peerName, namedFile);
    });
  };

  const handleLeave = () => {
    if (sessionEndedMsg === "The session has been ended by the host.") {
      clearSession();
      clearGuestSessionEnded();
      useStore.getState().reset();
      window.location.href = "/";
      return;
    }

    setLeaveLoading(true);
    requestLeave((res) => {
      setLeaveLoading(false);
      if (res.ok) {
        clearSession();
        clearGuestSessionEnded();
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

        <div className="header-right">
          <button
            className="theme-btn"
            onClick={() => setTheme(nextTheme)}
            title={`Switch to ${nextTheme} mode`}
            aria-label={`Switch to ${nextTheme} mode`}
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>

          <button className="leave-btn" onClick={handleLeave} disabled={leaveLoading || leaveStatus === "pending"}>
            {leaveStatus === "pending" ? "Awaiting approval..." : leaveLoading ? "..." : "Leave"}
          </button>
        </div>
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
            {allPeers.map(p => {
              const isMe = p.id === mySocketId;
              return (
                <div key={p.id} className={`device-chip ${p.isHost ? "host" : ""} ${isMe ? "me" : ""}`}>
                  {p.device === "phone" ? "📱" : "💻"} {p.name}
                  {isMe && <span className="you-tag">You</span>}
                </div>
              );
            })}
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

            <div className="drop-zone folder-drop-zone" onClick={() => hostFolderRef.current.click()}>
              <input
                type="file"
                ref={hostFolderRef}
                style={{ display: "none" }}
                webkitdirectory=""
                directory=""
                multiple
                onChange={e => {
                  handleFolderSendTo(hostId, host.name, e.target.files);
                  e.target.value = "";
                }}
              />
              <div className="drop-icon-big">🗂️</div>
              <div>Send folder to <strong>{host.name}</strong></div>
              <div className="folder-drop-hint">All files in the selected folder will be queued automatically</div>
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

            <div
              className={`drop-zone folder-drop-zone ${!selectedTarget ? "disabled-zone" : ""}`}
              onClick={() => {
                if (!selectedTarget) return;
                folderRef.current?.click();
              }}
            >
              <div className="drop-icon-big">🗂️</div>
              <div>
                {!selectedTarget
                  ? "Select a guest, then send a folder"
                  : <>Send folder to <strong>{selectedTarget.name}</strong></>}
              </div>
              <div className="folder-drop-hint">All files in the selected folder will be queued automatically</div>
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

            <input
              type="file"
              ref={folderRef}
              style={{ display: "none" }}
              webkitdirectory=""
              directory=""
              multiple
              onChange={e => {
                if (selectedTarget && e.target.files?.length) {
                  handleFolderSendTo(selectedTarget.id, selectedTarget.name, e.target.files);
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

      {sessionEndedMsg === "The session has been ended by the host." && (
        <div className="modal-overlay">
          <div className="modal end-session-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span>Session Ended</span>
            </div>
            <div className="modal-body">
              <p className="end-session-copy">The session has been ended by the host.</p>
              <div className="end-session-actions">
                <button className="btn-end-confirm" onClick={handleLeave}>Leave Room</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}