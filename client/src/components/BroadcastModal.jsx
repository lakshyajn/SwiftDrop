import { useRef } from "react";

export default function BroadcastModal({ peers, onSend, onClose }) {
  const fileRef = useRef();

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>📡 Broadcast to All</span>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="modal-recipients">
            <div className="modal-label">Recipients ({peers.length})</div>
            {(peers || []).map(p => (
              <div key={p.id} className={`modal-peer ${p.busy ? "busy" : ""}`}>
                {p.device === "phone" ? "📱" : "💻"} {p.name}
                {p.busy && <span className="busy-tag">BUSY</span>}
              </div>
            ))}
          </div>
          <div
            className="drop-zone"
            onClick={() => fileRef.current.click()}
          >
            <input
              type="file" ref={fileRef} style={{display:"none"}}
              onChange={e => { if(e.target.files[0]) onSend(e.target.files[0]); }}
            />
            <div className="drop-icon-big">📁</div>
            <div>Select file to broadcast</div>
          </div>
        </div>
      </div>
    </div>
  );
}
