## Summary

Enhance the `/api/engine/health` endpoint to return useful diagnostics beyond just `{status: 'ok'}`.

### Before
```json
{"status": "ok"}
```

### After
```json
{
  "status": "ok",
  "uptime": 3600,
  "memory": { "rss": 85, "heapUsed": 42, "heapTotal": 65 },
  "node": "v20.11.0",
  "env": "development"
}
```

### Why
Self-hosted users have no visibility into whether their instance is healthy, how much memory it's using, or how long it's been running. This is especially useful for debugging deployment issues and monitoring. No auth required (same as before) — it's a health check, not a data endpoint.

### Files changed
- `engine/backend/src/server.ts` — enhanced health endpoint response
