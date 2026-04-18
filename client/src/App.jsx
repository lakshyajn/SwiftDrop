import { useEffect, useState } from "react";
import { useStore }       from "./store";
import { useSwiftDrop, setServerConfig, clearGuestSessionEnded } from "./hooks/useSwiftDrop";
import SetupView  from "./components/SetupView";
import HostView   from "./components/HostView";
import GuestView  from "./components/GuestView";
import "./index.css";

const THEME_KEY_DEFAULT = "swiftdrop_theme_default";

function normalizeTheme(v) {
  return v === "light" || v === "dark" ? v : null;
}

function themeScopeKey(role, roomId, myName) {
  if (!role || !roomId || !myName) return THEME_KEY_DEFAULT;
  const safeName = String(myName).trim().toLowerCase().replace(/\s+/g, "_");
  return `swiftdrop_theme_${role}_${roomId}_${safeName}`;
}

function detectDevice() {
  return /Android|iPhone|iPad/i.test(navigator.userAgent) ? "phone" : "laptop";
}

export default function App() {
  const { role, roomId, myName, theme, setTheme, setServerInfo } = useStore();
  const { initSocket } = useSwiftDrop();
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    // Do not persist the guest-ended gate across fresh visits.
    clearGuestSessionEnded();

    const savedTheme = normalizeTheme(localStorage.getItem(THEME_KEY_DEFAULT));
    if (savedTheme) {
      setTheme(savedTheme);
    } else {
      const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
      setTheme(prefersDark ? "dark" : "light");
    }

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

  useEffect(() => {
    const scoped = normalizeTheme(localStorage.getItem(themeScopeKey(role, roomId, myName)));
    if (scoped && scoped !== theme) {
      setTheme(scoped);
    }
  }, [role, roomId, myName]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY_DEFAULT, theme);
    localStorage.setItem(themeScopeKey(role, roomId, myName), theme);
  }, [theme, role, roomId, myName]);

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
