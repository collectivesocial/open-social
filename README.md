# OpenSocial API

Community management infrastructure for ATProto applications.

## Features
- App registration and API key management
- Community creation and management  
- Membership tracking via ATProto records
- Admin permissions and OAuth

## Quick Start

See [DEPLOYMENT.md](./DEPLOYMENT.md) for complete setup instructions.

## API Documentation

### Authentication
All endpoints require an API key passed via `X-Api-Key` header.

### Endpoints
- `POST /api/v1/apps/register` - Register new app
- `POST /api/v1/communities` - Create community
- `GET /api/v1/communities` - List communities
- `POST /api/v1/communities/:id/members` - Join community

## Development
```bash
npm install
cp .env.example .env
# Edit .env with your values
npm run dev

## API Endpoint

The OpenSocial API is available at:
```
https://api.opensocial.community:8443
```

## Health Check
```bash
curl https://api.opensocial.community:8443/health
```