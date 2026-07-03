# OpenSocial API

Community management infrastructure for ATProto applications.

## Features

- App registration and API key management
- Community creation and management
- Membership tracking via ATProto records
- Admin permissions and OAuth

## Required Environment Variables

The following environment variables are **required** for the API server to start:

### Security (Critical)

- **`ENCRYPTION_KEY`** - 64-character hexadecimal string (32 bytes) used for encrypting secrets at rest
  - Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  - Must be exactly 64 characters (0-9, a-f, A-F)
  - Required for encrypting community app passwords and API keys

- **`COOKIE_SECRET`** - Secret key for session cookie signing
  - Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
  - Must be at least 32 characters
  - Cannot be left at default placeholder values

- **`DATABASE_URL`** - PostgreSQL connection string
  - Format: `postgresql://user:password@host:port/database`
  - Example: `postgresql://opensocial_api:password@localhost:5432/opensocial`

### Environment

- **`NODE_ENV`** - Application environment (`development`, `production`, `test`)
  - Must be set to `production` when deploying to production (with HTTPS SERVICE_URL)
  - Defaults to `development`

### Optional

- `PORT` - Server port (default: 3001)
- `LOG_LEVEL` - Logging level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` (default: `info`)
- `SERVICE_URL` - Public URL of this API service (for OAuth callbacks)
- `PLC_URL` - ATProto PLC directory URL (default: `https://plc.directory`)
- `PDS_URL` - ATProto PDS URL used as a fallback when resolving a community's PDS endpoint (default: `https://bsky.social`). OAuth login supports any ATProto PDS — users are not restricted to this PDS.
- `PRIVATE_KEYS` - JSON array of JWK private keys for OAuth

## Quick Start

See [DEPLOYMENT.md](./DEPLOYMENT.md) for complete setup instructions.

### Basic Setup

1. Copy `.env.example` to `.env`:

   ```bash
   cp .env.example .env
   ```

2. Generate required secrets:

   ```bash
   # Generate ENCRYPTION_KEY
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

   # Generate COOKIE_SECRET
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

3. Update `.env` with your values:

   ```bash
   DATABASE_URL=postgresql://user:password@localhost:5432/opensocial
   ENCRYPTION_KEY=<generated-encryption-key>
   COOKIE_SECRET=<generated-cookie-secret>
   NODE_ENV=development
   ```

4. Start the server:
   ```bash
   npm install
   npm run dev
   ```

The server will validate all required environment variables at startup and fail fast with clear error messages if any are missing or invalid.

## API Documentation

See **[docs/API.md](docs/API.md)** for the full group management API reference,
including authentication, membership, roles and permissions, records,
announcements, hierarchy, webhooks, and the XRPC surface.

Related design docs:

- [docs/PERMISSIONED_DATA.md](docs/PERMISSIONED_DATA.md) — roadmap for adopting
  atproto permissioned data (proposal 0016), starting with the group-only
  announcement space
- [docs/RUST_REWRITE.md](docs/RUST_REWRITE.md) — assessment of rewriting the
  service in Rust

### Quick orientation

- App-facing endpoints live under `/api/v1/` and authenticate with an API key
  (`X-Api-Key` header) or HTTP Message Signatures
- User-facing endpoints (web UI) authenticate with atproto OAuth sessions
- An ATProto-style XRPC surface is exposed under `/xrpc/`

## Local Development (devnet)

Run against a local ATProto network instead of production bsky.social.
This gives you your own PDS, PLC directory, and seeded test accounts.

### Prerequisites

- Node.js 20+
- Docker and Docker Compose v2
- [atproto-devnet](https://github.com/OpenMeet-Team/atproto-devnet) cloned as a sibling directory

### Setup

```bash
# Clone both repos side-by-side
git clone https://github.com/collectivesocial/open-social.git
git clone https://github.com/OpenMeet-Team/atproto-devnet.git

# Install dependencies
cd open-social
npm install
```

### Start the devnet

```bash
npm run devnet:up
```

This starts PDS, PLC, Jetstream, TAP, Postgres, and MailDev in Docker,
then seeds two test accounts (Alice and Bob). Credentials are written to
`../atproto-devnet/data/accounts.json`.

### Run the app

```bash
npm run dev:devnet
```

Loads config from `.env.devnet` (checked into git — all values are
throwaway devnet defaults) and starts the app on http://localhost:3001.

### Run the smoke test

```bash
npm run test:devnet
```

Creates a community via the API, then verifies the ATProto records
(profile, admins) landed on the local PDS.

### Stop the devnet

```bash
npm run devnet:down
```

Tears down all containers and volumes. Next `devnet:up` starts fresh.

### npm scripts reference

| Script        | What it does                                  |
| ------------- | --------------------------------------------- |
| `devnet:up`   | Start the ATProto devnet + Postgres + MailDev |
| `devnet:down` | Stop and remove all devnet containers/volumes |
| `dev:devnet`  | Start the app against the local devnet        |
| `test:devnet` | Run the devnet smoke test                     |

### Directory layout

```
parent/
├── open-social/           # This repo
│   ├── .env.devnet        # Devnet config (checked in, safe defaults)
│   ├── docker-compose.devnet.yml  # Postgres + MailDev overlay
│   └── scripts/
│       ├── start-test-env.sh      # Orchestrates devnet startup
│       └── stop-test-env.sh       # Tears down devnet
└── atproto-devnet/        # Local ATProto network
    ├── docker-compose.yml # PDS, PLC, Jetstream, TAP, init
    ├── .env               # Port configuration
    └── data/
        └── accounts.json  # Seeded test accounts (generated)
```

## Production

```bash
cp .env.example .env
# Edit .env with real values (PDS_URL, DATABASE_URL, etc.)
npm run dev
```
