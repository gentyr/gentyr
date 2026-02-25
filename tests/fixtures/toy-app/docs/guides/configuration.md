# Configuration

The Toy App is configured via environment variables.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port the server listens on |
| `LOG_LEVEL` | `info` | Logging verbosity (`debug`, `info`, `warn`, `error`) |
| `TOKEN_SECRET` | *(required)* | Secret key used to sign authentication tokens |
| `TOKEN_TTL` | `86400` | Token time-to-live in seconds (default: 24 hours) |

## Example

Create a `.env` file in your project root:

```
PORT=8080
LOG_LEVEL=debug
TOKEN_SECRET=my-secret-key
TOKEN_TTL=3600
```

Then start the server normally. Environment variables in `.env` are loaded automatically.
