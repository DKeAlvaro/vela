# Face matching eval

Does the on-device matcher (Human 3.3.6, the app's exact config) recognise the same person across photos and stay silent for strangers?

**Data:** 5 people x 3 photos + 4 strangers, public-figure portraits from Wikimedia Commons ([licences](fixtures/faces/SOURCES.md)). 15 genuine pairs, 156 impostor pairs.

```bash
cd facetest && npm install && node facetest.mjs
```
Runs the WASM backend in Node (the app uses WebGL; same models). Install ImageMagick for the resize step, or numbers shift slightly.

## Results (1024 px)
Same person: mean 0.53, min 0.32. Impostors: mean 0.23, max 0.46.

| Threshold | 1 enrolment photo: true / false match | 2 photos: true / false match |
|---|---|---|
| 0.45 | 80% / 0% | 80% / 0% |
| 0.50 | 80% / 0% | 80% / 0% |
| 0.525 | 60% / 0% | 80% / 0% |
| 0.55 | 50% / 0% | 80% / 0% |

At 640 px, 0.45 gave one false match. The app uses **0.52** with 2-3 enrolment photos. Small test: a sanity check, not a benchmark.
