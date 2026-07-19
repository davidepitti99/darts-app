# Dart Strategy Viewer

Interactive dartboard app that shows the **optimal aim** for a given score, darts left, and player accuracy (σ).

**Live app:** https://davidepitti99.github.io/darts-app/

## Use on iPhone

1. Open the link above in **Safari**
2. Tap **Share → Add to Home Screen**
3. After the first load it works offline

## How it works

This page is a self-contained Progressive Web App (single `index.html`). Precomputed optimal policies for each accuracy level are embedded as JSON — there is no server and no runtime solver.

**Controls**

| Control | Meaning |
|---|---|
| **Game** | `501` (single-in) or `301 double-in` |
| **Score left** | Points remaining |
| **Darts left** | Darts remaining in the current turn (3 / 2 / 1) |
| **Accuracy σ** | Gaussian throw spread in mm (lower = more accurate) |

**Display**

- Dartboard with the optimal aim (yellow ×) and 1σ / 2σ spread rings
- Aim label and expected turns to finish
- **σ-sensitivity** for that score across all embedded accuracies:
  - **drift** — max distance (mm) the optimal aim moves as σ changes
  - **regions** — how many distinct target beds the aim visits across σ

Colors use natural-gap thresholds:

| | Green | Orange | Red |
|---|---|---|---|
| Drift | &lt; 75 mm | 75–150 mm | &gt; 150 mm |
| Regions | 1 | 2–3 | 4+ |

## Updating the app

This repo only hosts the built HTML. Source lives in the private `Risiko` project under `darts/`:

```text
python generate_policies.py   # compute CSVs (optional)
python build_iphone_app.py    # rebuild darts_aim.html
# copy darts_aim.html → index.html here, then commit & push
```

GitHub Pages redeploys from `main` automatically.
