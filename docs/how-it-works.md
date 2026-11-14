# How it works

You look at someone and tell Vela who they are. The next time that person is in view, she says it softly. For a face she does not know, she says nothing.

> "This is Pedro, my neighbour from the second floor."
> Later: "That's Pedro, your neighbour from the second floor."

## 1. Your glasses
The first screen reads the live glasses status and offers the one action that fixes it.

| Status | Button |
|---|---|
| Glasses need an update | Open Meta AI |
| Not linked | Connect |
| Not nearby | Try again |
| Ready (shows battery) | Continue |

**Use the phone camera for now** is always there. Outside the Android shell the app uses the phone camera.

## 2. Teaching a face
- Vela asks you to look at the person and say who they are, in English or Spanish ("Pedro, mi vecino").
- While she listens, the camera takes 2 or 3 photos and finds the face on the phone.
- One answer gives the name and the relation. If only a name comes, she asks "Who is Pedro to you?"
- She repeats it back, you say yes, she saves it and asks "Anyone else?"

## 3. Watching
- A photo every 3 s while the view changes (10 s when it does not), about every 2 s while a face is in view.
- On a match she speaks once per person per 10 minutes.
- Match threshold 0.52 (see [face matching results](../eval/README.md)).

## 4. Voice commands
Say "Vela, ..." (a follow-up within 10 s needs no name).

| Say | Does |
|---|---|
| remember this person | teaches a face |
| who is this? | answers now |
| start / stop | starts or rests the camera (she keeps listening) |
| what can you do? / repeat | help / repeats her last line |
| set up again | restarts onboarding |

## 5. On screen
What Vela is doing, her last line as a caption, and what she heard ("I heard: ...") before she acts. **For family** lists the people (rename the relation, remove) and today's moments.

Next: [Privacy](privacy.md) · [Architecture](architecture.md)
