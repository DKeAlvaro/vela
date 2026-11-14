# How it works

You look at someone and tell Vela who they are. Next time that person is in view, she says it softly. Unknown faces: silence.

## Teaching a face
- She asks you to look at the person and say who they are, in English or Spanish ("Pedro, mi vecino").
- Photos are taken while she listens; the face is found on the phone.
- If you only give a name, she asks "Who is Pedro to you?". She repeats it back, you say yes, she asks "Anyone else?"

## Watching
- A photo every 3 s (10 s if the view is static), every ~2 s while a face is in view.
- On a match she speaks once per person per 10 minutes. Threshold 0.52 ([results](../eval/README.md)).

## Voice commands
Say "Vela, ..." (a follow-up within 10 s needs no name).

| Say | Does |
|---|---|
| remember this person | teaches a face |
| who is this? | answers now |
| start / stop | start or rest the camera (she keeps listening) |
| what can you do? / repeat | help / last line again |
| set up again | restarts onboarding |

The screen only mirrors what she is doing and what she heard. The one place with buttons is **For family**: the people she knows (edit, remove) and today's moments.

[Privacy](privacy.md) · [Architecture](architecture.md)
