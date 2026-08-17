# Darts scorekeeper (password gated)

Live: https://davidepitti99.github.io/darts-app/

The page asks for a site password (see `Risiko/darts/.site_password` after `python build_iphone_app.py`).

## Publish beta (auto version + commit stamp)

From this repo root, run:

```powershell
.\publish-beta.ps1
```

What it does:
- updates `beta/index.html` version text and cache-bust token from git state
- commits all current changes
- pushes to `origin/main`
