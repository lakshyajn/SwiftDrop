import { useState, useEffect } from "react";
import { useStore } from "../store";
import { saveSession } from "../hooks/useSwiftDrop";

const MAX_USERNAME_LENGTH = 20;

function generateRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export default function SetupView() {
  const { serverInfo, myDevice } = useStore();
  const pendingRoom = useStore(s => s.pendingRoom);
  const hostCreateError = useStore(s => s.hostCreateError);

  const [name,    setName]    = useState("");
  const [roomId,  setRoomId]  = useState(pendingRoom || "");
  const [tab,     setTab]     = useState(pendingRoom ? "join" : "host");
  const [error,   setError]   = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (pendingRoom) { setTab("join"); setRoomId(pendingRoom); }
  }, [pendingRoom]);

  useEffect(() => {
    if (!hostCreateError) return;
    setLoading(false);
    setError(hostCreateError);
  }, [hostCreateError]);

  const createRoom = () => {
    const trimmedName = name.trim();
    if (!trimmedName) { setError("Enter your name"); return; }
    if (trimmedName.length > MAX_USERNAME_LENGTH) {
      setError(`Name must be ${MAX_USERNAME_LENGTH} characters or fewer`);
      return;
    }
    useStore.setState({ pendingHostCreate: null, hostCreateError: null });
    setLoading(true); setError("");
    const id   = generateRoomId();
    const sock = window._swiftSock;
    if (!sock) { setError("Not connected to server yet"); setLoading(false); return; }

    sock.emit("create-room", { roomId: id, name: trimmedName, device: myDevice }, (res) => {
      if (res?.pendingApproval) {
        useStore.setState({ pendingHostCreate: { roomId: id, name: trimmedName, device: myDevice }, hostCreateError: null });
        setLoading(false);
        setError("Waiting for host approval...");
        return;
      }
      if (res?.error) { setError(res.error); setLoading(false); return; }
      
      // Save the token so auto-rejoin works!
      saveSession({ token: res.token, roomId: id, name: trimmedName, device: myDevice, isHost: true });
      
      useStore.setState({ role: "host", roomId: id, myName: trimmedName, isHost: true });
    });
  };

  const joinRoom = () => {
    const trimmedName = name.trim();
    if (!trimmedName)   { setError("Enter your name"); return; }
    if (trimmedName.length > MAX_USERNAME_LENGTH) {
      setError(`Name must be ${MAX_USERNAME_LENGTH} characters or fewer`);
      return;
    }
    if (!roomId.trim()) { setError("Enter room ID"); return; }
    setLoading(true); setError("");
    const sock = window._swiftSock;
    if (!sock) { setError("Not connected to server yet"); setLoading(false); return; }

    sock.emit("join-room",
      { roomId: roomId.trim().toUpperCase(), name: trimmedName, device: myDevice },
      (res) => {
        if (res?.error) { setError(res.error); setLoading(false); return; }
        
        // Save the token so auto-rejoin works!
        saveSession({ token: res.token, roomId: roomId.trim().toUpperCase(), name: trimmedName, device: myDevice, isHost: false });
        
        useStore.setState({
          role:   "guest",
          roomId: roomId.trim().toUpperCase(),
          myName: trimmedName,
          isHost: false,
          hostId: res.hostId,
          peers:  res.peers || [],
          pendingRoom: null,
        });
      }
    );
  };

  return (
    <div className="setup-page">
      <div className="setup-card">
        <div className="setup-header">
          <div className="app-logo">
            <div className="logo-icon">⚡</div>
            <div>
              <div className="logo-name">SwiftDrop</div>
              <div className="logo-sub">P2P File Sharing</div>
            </div>
          </div>
        </div>

        {serverInfo?.qr && tab === "host" && (
          <div className="qr-section">
            <img src={serverInfo.qr} alt="QR" className="qr-img" />
            <div className="qr-hint">Share this QR — others can join your room</div>
            <div className="qr-url">{serverInfo.url}</div>
          </div>
        )}

        <div className="tab-row">
          <button className={`tab-btn ${tab === "host" ? "active" : ""}`} onClick={() => setTab("host")}>Host Room</button>
          <button className={`tab-btn ${tab === "join" ? "active" : ""}`} onClick={() => setTab("join")}>Join Room</button>
        </div>

        <div className="setup-form">
          <input className="input" placeholder="Your display name"
            value={name} onChange={e => setName(e.target.value)}
            maxLength={MAX_USERNAME_LENGTH}
            onKeyDown={e => e.key === "Enter" && (tab === "host" ? createRoom() : joinRoom())}
            autoFocus />

          {tab === "join" && (
            <input className="input" placeholder="Room ID (e.g. AB12CD)"
              value={roomId} onChange={e => setRoomId(e.target.value.toUpperCase())}
              maxLength={6}
              onKeyDown={e => e.key === "Enter" && joinRoom()} />
          )}

          {error && <div className="error-msg">{error}</div>}

          <button className="btn-primary"
            onClick={tab === "host" ? createRoom : joinRoom}
            disabled={loading}>
            {loading ? "Connecting..." : tab === "host" ? "Create Room" : "Join Room"}
          </button>
        </div>

        {serverInfo && (
          <div className="server-info">
            <span className="dot green" />
            {serverInfo.ip}:{serverInfo.port}
          </div>
        )}
      </div>
    </div>
  );
}
