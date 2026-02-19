# PageSync Plugin for RemNote

PageSync lets you mirror the currently open Rem across devices (for example: laptop + tablet).

This repository contains two parts:

- `plugin/`: RemNote plugin (UI + host/client sync logic)
- `server/`: lightweight Node.js sync relay server (HTTP + WebSocket)

## How It Works

- **Host device** publishes page/rem changes.
- **Client devices** follow those changes in real time.
- Sync uses **Rem IDs** (not URL strings) for navigation consistency.

## Quick Start

1. Start the server:
   - `cd server`
   - `npm install`
   - `npm start`
2. Run/build the plugin:
   - `cd plugin`
   - `npm install`
   - `npm run dev` (development) or `npm run build` (package)
