import { useEffect, useState } from "react";
import { useStore }       from "./store";
import { useSwiftDrop, setServerConfig } from "./hooks/useSwiftDrop";
import SetupView  from "./components/SetupView";
import HostView   from "./components/HostView";
import GuestView  from "./components/GuestView";
import "./index.css";

function detectDevice() {
  return /Android|iPhone|iPad/i.test(navigator.userAgent) ? "phone" : "laptop";
}

export default function App() {
  const { role, setServerInfo } = useStore();
  const { initSocket } = useSwiftDrop();
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    useStore.setState({ myDevice: detectDevice() });

    // Check URL for ?room= param (from QR scan) — auto-switch to guest join
    const urlRoom = new URLSearchParams(window.location.search).get("room");
    if (urlRoom) {
      useStore.setState({ pendingRoom: urlRoom });
    }

    fetch("/api/server-info")
      .then(r => { if (!r.ok) throw new Error("Server unreachable"); return r.json(); })
      .then(info => {
        setServerInfo(info);
        setServerConfig(info); // wire TURN config into WebRTC engine

        const serverUrl = (import.meta.env.DEV)
          ? `http://${window.location.hostname}:3001`
          : window.location.origin;

        initSocket(serverUrl);
        setLoading(false);
      })
      .catch(err => {
        console.error("Server info error:", err);
        setError("Cannot reach server. Make sure the backend is running.");
        setLoading(false);
      });
  }, []);

  if (loading) return (
    <div className="loading-screen">
      <div className="loading-logo">⚡ SwiftDrop</div>
      <div className="loading-sub">Connecting to server...</div>
    </div>
  );

  if (error) return (
    <div className="loading-screen">
      <div className="loading-logo">⚡ SwiftDrop</div>
      <div className="loading-sub" style={{ color: "#ef4444", maxWidth: 320, textAlign: "center" }}>{error}</div>
    </div>
  );

  if (!role)          return <SetupView />;
  if (role === "host") return <HostView />;
  if (role === "guest") return <GuestView />;
}
