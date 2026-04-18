import { useRef, useState } from "react";
import JSZip from "jszip";

async function collectDroppedFiles(event) {
  const items = Array.from(event.dataTransfer?.items || []);
  if (items.length === 0) return Array.from(event.dataTransfer?.files || []);

  const files = [];

  const walkEntry = async (entry, prefix = "") => {
    if (!entry) return;
    if (entry.isFile) {
      await new Promise((resolve) => {
        entry.file((file) => {
          const relativeName = `${prefix}${file.name}`;
          files.push(relativeName === file.name ? file : new File([file], relativeName, { type: file.type, lastModified: file.lastModified }));
          resolve();
        });
      });
      return;
    }

    if (entry.isDirectory) {
      const reader = entry.createReader();
      const children = await new Promise((resolve) => reader.readEntries(resolve));
      for (const child of children) {
        await walkEntry(child, `${prefix}${entry.name}/`);
      }
    }
  };

  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) {
      await walkEntry(entry);
    } else if (item.kind === "file") {
      const file = item.getAsFile?.();
      if (file) files.push(file);
    }
  }

  return files;
}

function inferRootFolderName(files) {
  const withRelative = (files || []).find((f) => String(f.webkitRelativePath || "").includes("/"));
  if (withRelative) {
    const first = String(withRelative.webkitRelativePath).split("/")[0];
    if (first) return first;
  }

  const withSlashName = (files || []).find((f) => String(f.name || "").includes("/"));
  if (withSlashName) {
    const first = String(withSlashName.name).split("/")[0];
    if (first) return first;
  }

  return "BroadcastFolder";
}

async function buildFolderArchive(files) {
  const list = Array.from(files || []);
  if (list.length === 0) return null;

  const rootFolder = inferRootFolderName(list);
  const zip = new JSZip();

  for (const file of list) {
    const relativePath = String(file.webkitRelativePath || file.name || "").replace(/^\/+/, "");
    const hasRootPrefix = relativePath.startsWith(`${rootFolder}/`);
    const zipPath = hasRootPrefix ? relativePath : `${rootFolder}/${relativePath}`;
    zip.file(zipPath, file);
  }

  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  return new File([blob], `${rootFolder}.zip`, { type: "application/zip", lastModified: Date.now() });
}

export default function BroadcastModal({ peers, onSend, onClose }) {
  const fileRef = useRef();
  const folderRef = useRef();
  const [isPackingFolder, setIsPackingFolder] = useState(false);

  const sendFolderAsArchive = async (files) => {
    const list = Array.from(files || []);
    if (list.length === 0) return;
    setIsPackingFolder(true);
    try {
      const archive = await buildFolderArchive(list);
      if (archive) onSend(archive);
    } catch (err) {
      console.error("Folder archive build failed:", err);
      alert("Could not prepare folder for broadcast. Please try again.");
    } finally {
      setIsPackingFolder(false);
    }
  };

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
            onClick={() => !isPackingFolder && fileRef.current.click()}
          >
            <input
              type="file" ref={fileRef} style={{display:"none"}}
              onChange={e => {
                if (e.target.files[0]) onSend(e.target.files[0]);
                e.target.value = "";
              }}
            />
            <div className="drop-icon-big">📁</div>
            <div>Select file to broadcast</div>
          </div>

          <div
            className="drop-zone folder-drop-zone"
            onClick={() => !isPackingFolder && folderRef.current.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={async (e) => {
              e.preventDefault();
              if (isPackingFolder) return;
              const files = await collectDroppedFiles(e);
              if (files.length > 0) await sendFolderAsArchive(files);
            }}
          >
            <input
              type="file"
              ref={folderRef}
              style={{ display: "none" }}
              webkitdirectory=""
              directory=""
              multiple
              onChange={async (e) => {
                const files = Array.from(e.target.files || []);
                if (files.length > 0) await sendFolderAsArchive(files);
                e.target.value = "";
              }}
            />
            <div className="drop-icon-big">🗂️</div>
            <div>{isPackingFolder ? "Preparing folder archive..." : "Drop or click to broadcast a folder"}</div>
            <div className="folder-drop-hint">
              {isPackingFolder ? "Please wait while we pack the folder" : "Receivers save once and get the full folder structure"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
