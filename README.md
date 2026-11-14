<img src="docs/img/banner2.jpg" alt="vela. Growing old doesn’t mean losing independence." width="100%">

Vela remembers faces: tell her who someone is once, and next time she says it quietly in your ear through your Ray-Ban Meta glasses.

## There is no interface
You only talk. No menus, no settings.

> **You** (looking at Marta): "Vela, remember this person."
> **Vela:** "Look at the person and tell me who they are."
> **You:** "Marta, mi nieta."
> **Vela:** "Marta. Right?" **You:** "Yes." **Vela:** "Saved Marta."
>
> *Next day, Marta walks in.* **Vela**, in your ear: "That's Marta, your granddaughter."

A stranger gets silence. Nothing is kept about them.

## Quick answers
| | |
|---|---|
| Does an AI look at faces? | **No.** Faces are matched on the phone by a small face-embedding model. No photo leaves it. |
| Which models? | Human (BlazeFace + FaceRes) for faces · Groq Whisper large-v3-turbo for speech · Groq gpt-oss-20b for name and relation · ElevenLabs Flash v2.5 for her voice |
| What leaves the phone? | Short audio clips, the transcript, and the text she speaks. [Details](docs/privacy.md) |
| Does she get it wrong? | She would rather stay quiet than name the wrong person. [Measured](eval/README.md) |
| What does it need? | An Android phone and Ray-Ban Meta glasses. Without glasses, the phone camera works. |
| Anything else besides faces? | No. One thing, done well. |

- [How it works](docs/how-it-works.md)
- [FAQ](docs/faq.md)
- [Privacy](docs/privacy.md)
- [Use it with Ray-Ban Meta glasses](docs/glasses.md)
- [Run it yourself](docs/run.md)
- [Architecture](docs/architecture.md)
- [Website](https://meetvela.tech)
