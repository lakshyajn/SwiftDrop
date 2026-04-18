# SwiftDrop Deployment Guide (Admin)

## Overview
SwiftDrop is a LAN-only, offline peer-to-peer file transfer app. This guide covers production deployment of desktop installers across your organization.

## Network Requirements
- All devices must be on the same LAN segment (or routable VLANs with proper firewall rules).
- TCP port 3001 open between clients and host machine.
- UDP/TCP port 3478 open if TURN relay is used.
- mDNS/local hostname resolution is optional but recommended.

## System Requirements
- Windows 10/11 (x64 preferred)
- macOS 12+
- Linux with AppImage support (glibc-compatible distributions)

## Installer Artifacts
- Windows: `.exe` (NSIS) and portable executable
- macOS: `.dmg`
- Linux: `.AppImage` and `.deb`

Artifacts are generated under:
- `dist/packages/`

## Build Commands
Run at repository root:

```bash
npm install
npm run electron:build:all
```

Platform-specific builds:

```bash
npm run electron:build:win
npm run electron:build:mac
npm run electron:build:linux
```

## First-Run Behavior
- First running host instance becomes network approver.
- Additional host creation requests require approver approval.
- If approver disconnects, server attempts auto-recovery/election.

## Security Baseline
- Keep app confined to trusted internal networks.
- Use endpoint protection allowlisting for signed binaries.
- Restrict installer distribution to internal channels only.
- If code signing is enabled, keep certificates in secure secret storage.

## Rollout Strategy
1. Pilot with 5-10 users on one subnet.
2. Validate transfer performance with real files (small/large/mixed).
3. Expand to one department.
4. Roll out organization-wide.

## Validation Checklist
- Host creation approval flow works.
- Guest joins via room code/QR.
- Broadcast and direct transfers complete successfully.
- Rejoin after disconnect works.
- Session end and cleanup behavior is correct.

## Offline Support
SwiftDrop does not require internet for runtime operation.
Only same-LAN connectivity is required.
