# AGENTS.md for hermes-supervisor

## Overview
Hermes Supervisor — meta-layer MCP agent for orchestrating missions, research, and VPS management. Coordinates research, VPS inspection, memory, planning, fleet integration, and Telegram-driven operator workflows through a Model Context Protocol server.

## Development

### Setup
```bash
npm install
```

### Build
```bash
npm run build
```

### Type Check
```bash
npm test
```

### Run
```bash
npm start
# or with HTTP transport
npm run start:http
```

## Deployment
Deployed as a Docker Compose project on Hostinger VPS. HTTP MCP service on port 8150.
