# Face matching eval

Does the on-device matcher (Human 3.3.6: BlazeFace + FaceRes, the app's exact config) recognise the same person across photos and stay silent for strangers?

## Data
5 people x 3 photos and 4 strangers: portraits of public figures from Wikimedia Commons, each with its licence in [fixtures/faces/SOURCES.md](fixtures/faces/SOURCES.md). That gives 15 genuine pairs and 156 impostor pairs.

## Run
```bash
cd facetest
npm install
node facetest.mjs          # prints the table below, writes out/faces.json
```
It runs the WASM backend in Node (the app uses WebGL; models and similarity are identical). Install ImageMagick for the resize step, otherwise photos are decoded unresized and numbers move slightly.

## Results (1024 px, every face found)
Same person: similarity mean 0.53, min 0.32. Impostors: mean 0.23, max 0.46.

| Threshold | 1 enrolment photo: true match | false match | 2 enrolment photos (best of): true match | false match |
|---|---|---|---|---|
| 0.45 | 80% | 0% | 80% | 0% |
| 0.50 | 80% | 0% | 80% | 0% |
| 0.525 | 60% | 0% | 80% | 0% |
| 0.55 | 50% | 0% | 80% | 0% |

At 640 px with 2 enrolment photos, 0.45 gave one stranger false match; 0.475 to 0.525 gave none. The app uses **0.52** with 2 or 3 enrolment photos.

Small test (15 genuine pairs): read it as a sanity check, not a benchmark.

Back: [How it works](../docs/how-it-works.md)
