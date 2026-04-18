# SwiftDrop

SwiftDrop is a desktop-first, LAN file sharing app built with Electron + React + Socket.IO.
It is designed for fast, local transfers without requiring cloud storage or internet connectivity during normal use.

## Highlights

- Local network (LAN) peer-to-peer transfer workflow
- Host/guest room model with room code and QR join flow
- Host approval flow for controlled session creation
- Direct transfers and host broadcast transfers
- Transfer queue/progress visibility
- Session resilience features (rejoin and approver recovery)
- Offline runtime operation on trusted internal networks

## Tech Stack

- Desktop shell: Electron
- Frontend: React + Vite
- Backend: Node.js + Express + Socket.IO
- Optional relay: node-turn (TURN server on port 3478)

## Repository Structure

```text
client/      React app (UI)
server/      Express + Socket.IO signaling/control plane
electron/    Electron main/preload process
docs/        Deployment, troubleshooting, testing, quickstart
assets/      Installer/build resources (icons, images)
```

## Quick Start (Development)

Prerequisites:

- Node.js 18+
- npm 9+

Install dependencies:

```bash
npm install
npm install --prefix client
```

Run development mode:

```bash
npm run dev
```

This starts:

- backend server on port 3001
- Vite dev server for frontend

Run Electron in development:

```bash
npm run electron:dev
```

## Build Desktop Installers

From repository root:

```bash
npm run electron:build:all
```

Platform-specific commands:

```bash
npm run electron:build:win
npm run electron:build:mac
npm run electron:build:linux
```

Build artifacts are generated in:

- `dist/packages/`

## GitHub Actions Build (Win/Mac/Linux)

Cross-platform installer builds are automated in:

- `.github/workflows/build-installers.yml`

How it runs:

- Manual trigger from Actions tab (`workflow_dispatch`)
- Automatic trigger on version tags matching `v*`

Artifacts uploaded per platform:

- Windows: `.exe` installers
- macOS: `.dmg` and `.zip`
- Linux: `.AppImage` and `.deb`

## Installer Targets

Configured targets:

- Windows: NSIS installer (`.exe`) + portable executable
- macOS: DMG (`.dmg`) + ZIP (`.zip`)
- Linux: AppImage (`.AppImage`) + Debian package (`.deb`)

## How It Works

1. A user creates a room as host.
2. Guests join using room code or QR.
3. The host controls room policy and approvals.
4. Peers exchange transfer requests and confirm receives.
5. Server coordinates session state while transfers proceed over peer channels.

## Network Requirements

- Clients should be on the same LAN/VLAN or routable internal subnets
- TCP port 3001 open for signaling/control
- UDP/TCP port 3478 open if TURN relay is required

## Security Notes

- Intended for trusted internal networks
- Restrict installer distribution to approved internal channels
- If code-signing is enabled, keep certs/keys in secure secret storage

## Documentation

- Deployment guide: [docs/DEPLOYMENT_GUIDE.md](docs/DEPLOYMENT_GUIDE.md)
- User quick start: [docs/USER_QUICKSTART.md](docs/USER_QUICKSTART.md)
- Testing checklist: [docs/TESTING_CHECKLIST.md](docs/TESTING_CHECKLIST.md)
- Troubleshooting: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

## Troubleshooting (Quick)

- If peers cannot discover each other, verify both are on same LAN and firewall allows port 3001
- If transfers stall, test with smaller files first and check endpoint security software
- If TURN fallback is needed, confirm `node-turn` is available and port 3478 is reachable

## License

MIT
