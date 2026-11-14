# ElevenLabs for Vela (researched 2026-11-14)

Sources fetched today: [models](https://elevenlabs.io/docs/overview/models), [pricing](https://elevenlabs.io/pricing/api), [TTS stream API](https://elevenlabs.io/docs/api-reference/text-to-speech/stream), [WS stream-input](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input), [latency guide](https://elevenlabs.io/docs/best-practices/latency-optimization), [TTS best practices](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices), [STT convert](https://elevenlabs.io/docs/api-reference/speech-to-text/convert), [STT capability](https://elevenlabs.io/docs/overview/capabilities/speech-to-text), [STT realtime WS](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime). Fetched via a summarizing tool, so exact wording is paraphrased.

## 1. TTS models and latency
| Model ID | Median latency* | Languages | Char limit | $/1K chars |
|---|---|---|---|---|
| `eleven_v4_turbo` | ~100 ms | 90+ | not stated | 0.04 |
| `eleven_flash_v2_5` | ~100 ms | 32 | 40,000 | 0.04 |
| `eleven_flash_v2` | ~135 ms | English only | 30,000 | 0.04 |
| `eleven_v3_conversational` | ~165 ms | 70+ | not stated | 0.04 |
| `eleven_v4` | not stated | 90+ | 10,000 | 0.08 |
| `eleven_v3` | not stated | 70+ | 5,000 | 0.08 |
| `eleven_multilingual_v2` | not stated | 29 | 10,000 | 0.08 |
*Median, excluding network and application latency (models page). `eleven_turbo_v2_5`/`v2` are deprecated aliases of Flash.
- Flash over WebSocket: ~100-150 ms TTFB in North America/Europe/SE Asia, 150-200 ms South/NE Asia (latency guide). Regions: USA, Netherlands, Singapore. Check `x-region` header. Force US with `https://api.us.elevenlabs.io`.
- Trade-offs: Flash "trades a slight amount of audio quality for speed" vs Multilingual v2. Flash v2.5 reads numbers/currency worse (docs example: "$1,000,000"). v4/v3 are the "most emotive"; Multilingual v2 is "most stable on long-form". No independent MOS numbers found [unverified].
- v4 and v3 do NOT support SSML `<break>` tags (use ellipses/punctuation/audio tags). Break tags (<=3 s) work on other models; many per generation can cause instability.

## 2. Endpoints and formats
- HTTP: `POST /v1/text-to-speech/{voice_id}/stream` (default `model_id` is `eleven_multilingual_v2`, so always set it explicitly). Body: `text`, `model_id`, `voice_settings`, `language_code`, `seed`, `previous_text/next_text`, `apply_text_normalization`.
- WebSocket: `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input?model_id=...`. First message `text:" "`, then text ending in a space, `flush:true`, close with `""`. Key in `xi-api-key` header. `inactivity_timeout` default 20 s (max 180). `auto_mode` (default false) triggers generation automatically. Default `chunk_length_schedule` [120,160,250,290] chars: a 40-char line will not generate until flush. WS buffers input, so it can be slower than HTTP when full text is known (docs). For Vela's one short sentence: use HTTP stream (or WS with `flush:true`).
- `output_format` (default `mp3_44100_128`): mp3_22050_32, mp3_24000_48, mp3_44100_32/64/96/128/192, pcm_8000/16000/22050/24000/32000/44100/48000, ulaw_8000, alaw_8000, opus_48000_32/64/96/128/192. mp3 192 needs Creator+, pcm_44100 needs Pro+. For glasses: `pcm_24000` (no decode step) or `opus_48000_64` / `mp3_24000_48` for small payloads.
- `optimize_streaming_latency` (0-4): marked **Deprecated** in the API reference. Level 4 turns off the normalizer (mispronounces numbers/dates). Do not rely on it; choose a Flash/Turbo model instead.

## 3. Voice settings (calm, unhurried)
Defaults: stability 0.5, similarity_boost 0.75, style 0, speed 1.0, use_speaker_boost true. `speed` range 0.7-1.2 (best-practices page); extremes can hurt quality.
Suggested start (my judgement, test by ear): `speed 0.85-0.9`, `stability 0.6-0.75` (higher = steadier, more monotone), `similarity_boost 0.75`, `style 0` (non-zero adds latency/compute), `use_speaker_boost false` (small latency cost). Keep text with plain punctuation; a trailing full stop, no exclamation marks.

## 4. Voice candidates
Premade list (IDs and descriptions from [wavespeed mirror](https://wavespeed.ai/docs/docs-api/elevenlabs/elevenlabs-voice-id); official default-voices page returned 403). Verify with `GET /v1/voices` before use.
| Voice | voice_id | Description |
|---|---|---|
| Talia | `OZ0L6eISlOejga3XjDFt` | Warm, soft, relaxed female; calm narration |
| Maisie | `QtY3JBOUKEB5xzrRfOKc` | Warm, approachable female alto |
| Matilda | `XrExE9yKIg1WjnnlVkGX` | Professional woman, pleasing alto |
| Lily | `pFZP5JQG7iQjIQuC4Bku` | Velvety British female |
| Thomas | `GBv7mTt0atIp3Br8iCZE` | Soft, subdued male; meditation |
| George | `JBFqnCBsd6RMkjVDRZzb` | Warm resonance (male) |
| Brian | `nPczCjzI2devNBz1zQrb` | Resonant, comforting middle-aged male |
Avoid: Sarah/Bella (young, "confident"), Jessica/Laura (young), Charlotte (raspy).
- Spanish: premade voices are generally usable across a model's languages with accent carry-over [unverified for each voice]. Flash v2.5 lists 32 languages [Spanish presumed included, unverified on the page]. Audition each shortlisted voice with Spanish lines, or search the Voice Library for native Spanish voices (not done here) [unverified].

## 5. Pricing (pricing page, 2026-11-14)
Plans: Free (10K v4 chars / 20K Flash chars per month), Starter $6 (150K Flash chars), Creator $22 (550K), Pro $99 (2.475M), Scale $299 (7.475M), Business $990 (24.75M). Flash/Turbo costs half of v4/v3/v2 per char. Pages notes a promo "30,000 credits for $1" ended 30 Sep.
Estimate: 100 lines/day x ~50 chars = 5,000 chars/day = ~150K/month. Flash API rate: $0.20/day, ~$6/month. Fits Starter's 150K Flash allotment exactly, so Creator ($22) gives headroom. On v4 (0.08): ~$12/month. Mind the "~50 chars" assumption: 12 words is roughly 60-70 chars, so 100 such lines is 6.5K/day (~$8/month Flash).
Caching cuts this further (section 7).

## 6. Scribe STT
- Batch: `scribe_v3` (most accurate, 90+ languages, up to 32 speakers diarization, "27% fewer word errors than v2 on FLEURS"), `scribe_v2`, `scribe_v2_medical` (clinical audio, "35% fewer errors on clinical audio"; same API/price as v2; draft transcripts for professional review). `scribe_v1` deprecated.
- Realtime: `scribe_v3_live` ("44% lower semantic WER than v2 Realtime"; turn prediction), `scribe_v2_realtime` (median ~150 ms to committed transcript). No latency stated for v3 Live [unverified].
- Realtime WS: `wss://api.elevenlabs.io/v1/speech-to-text/realtime`, `audio_format` pcm_16000 default, `commit_strategy` manual | vad | turn_prediction, `language_code`, `multilang_mode`, up to 50 realtime keyterms (20 chars each).
- Batch API: sync response for short audio (min 100 ms); `webhook=true` for long files (202 then webhook). Limits: 5 GB, 15 h; files >8 min split into 4 parallel segments. `diarize`, `num_speakers`, `keyterms` (+20% surcharge), `language_code` optional (auto-detect), `timestamps_granularity`.
- Price per hour: v3/v2/v2 Medical $0.20; v3 Live/v2 Realtime $0.22. Silence is billed. Plans include hours (Starter 30 h batch/27 h live). A 45-min doctor visit costs about $0.15 batch.
- HIPAA/BAA: requires contacting Sales (Business-tier territory). Data retention policy not found [unverified]. Consent matters for doctor recordings.

## 7. Caching
Pre-render fixed lines (greetings, "I am here", reminders with templated names) once per voice/settings/model to mp3/opus files on device; zero latency, zero cost, offline. Use `seed` for reproducible renders, and re-render only on voice/settings change. Dynamic lines (LLM-generated) stream via Flash. Cache by hash of (text, voice_id, model, settings). Enable `previous_text/next_text` is irrelevant for single sentences.

## What it means for Vela
1. Default TTS: `eleven_flash_v2_5` over HTTP `/stream` (English and Spanish, ~100 ms model median, $0.04/1K). Try `eleven_v4_turbo` as the same-price upgrade for warmth; A/B by ear on 10 lines. Reserve `eleven_v4`/Multilingual v2 for pre-rendered lines where quality beats speed.
2. Always pass `model_id`; do not use `optimize_streaming_latency`. Request `pcm_24000` or `opus_48000_64`.
3. Settings start: speed 0.88, stability 0.65, similarity 0.75, style 0, speaker boost off.
4. Audition Talia, Maisie, Matilda, Thomas, George with 3 EN and 3 ES lines on the target glasses speaker; pick one voice and fix it, since consistency builds trust for an 81-year-old.
5. Budget is trivial (~$6-8/month at 100 lines/day on Flash); Creator plan for headroom. Pre-render every repeated line.
6. Yes/no replies: `scribe_v2_realtime` or `scribe_v3_live` with `commit_strategy=vad`, pcm_16000, `language_code` set; low volume, ~$0.22/h of audio streamed, so only open the stream when Vela asks a question.
7. Doctor visit: batch `scribe_v2_medical` or `scribe_v3` with `diarize=true`, `keyterms` for drug names; needs explicit consent and a BAA via Sales if used with real patient data.
8. Measure real TTFB from the glasses' network; published numbers exclude network.
