# Page Sync Server

Lightweight Node.js relay for the Page Sync RemNote plugin.

## What it does

- Accepts updates from host devices (`POST /update`)
- Stores latest state in memory (`GET /state`)
- Broadcasts updates to clients (`WS /ws`)
- Exposes health and metrics (`GET /health`, `GET /metrics`)

## Run

- `npm install`
- `npm start`

Default port: `9091` (override with `PORT`).
