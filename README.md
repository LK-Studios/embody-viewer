# Embody Viewer

A live, playable 3D viewer for **[Embody](https://github.com/newsbubbles/embody)**, the
deterministic world engine for agents by [newsbubbles](https://github.com/newsbubbles).

Connect it to an Embody world and your character's surroundings render as halftone dots or
ASCII art, with everyone present drawn as a silhouette. You type what you do in plain English,
and a narrator retells it in the manner of Frank Herbert.

LK Studio built it while playing **[The Glass Reach](https://github.com/newsbubbles/embody/tree/main/worlds/glass-reach)**,
one of Embody's example worlds: a desert fief, a cracked cistern, and a people who hold the
water. The world, its characters and their scripted minds live in the Embody repo (for
example, [Ossa's script](https://github.com/newsbubbles/embody/blob/main/worlds/glass-reach/scripts/ossa_on.py)).
This repo is only the window onto it.

> An independent viewer, not part of the Embody project. It talks to an Embody server
> through Embody's MCP interface and plays whichever seat your grant gives you.

| Halftone | ASCII | Typed commands and narrator |
| :---: | :---: | :---: |
| ![Corin on the Salt Road in halftone](docs/halftone.jpg) | ![The same scene in ASCII](docs/ascii.jpg) | ![A typed command previewed on Red Ridge](docs/typed-commands.jpg) |

## Run it

You need Node 18 or newer. There is nothing to install.

```bash
EMBODY_URL=https://your-embody-host/mcp EMBODY_TOKEN=your-grant npm start
```

Then open **http://localhost:4477**.

- `EMBODY_URL` is the Embody server's MCP endpoint, and `EMBODY_TOKEN` is your grant.
- If you already play Embody through Claude Code, leave both unset. The viewer reads the
  `embody` server entry in `~/.claude.json` and plays the same seat.
- `PORT` changes the local port.
- The token stays in the Node process. The page only talks to `127.0.0.1`.

**What you do in the viewer is real: other players see it.**

## What it does

**Renders the place you're in.** It's a two-pass WebGL2 renderer. The first pass raymarches
a small diorama (terrain, wireframe dunes and mountains, a striped sun, the place's
buildings and props) at about two texels per character cell. The second pass draws it at
full resolution as halftone dots or ASCII glyphs. Each place gets a seeded scene chosen
from its name and description (hold, yard, road, camp, ridge, flats or dunes), and the
time of day and weather set the sun height and dust.

**Draws people as silhouettes.** Bodies are signed distance fields: head, torso, limbs,
and an outfit inferred from what the world says about each person. Guards get helmets,
Keth get hoods and cloaks, carriers get packs and wide hats, and reeves and clerks get
long coats. People walk with a stride, face where they're going, and turn toward whoever
they're talking to. A blade is drawn only for you, or for a guard by trade, so the
viewer never reveals a hidden weapon.

**Takes plain English.** The command bar takes commands or ordinary sentences, and shows
how it read your line before you press Enter:

| You type | It does |
| --- | --- |
| `go yard`, `drink cistern`, `talk ossa about water` | the engine verb, matched against what you can do right now |
| `I walk over here and check the thing` | walks you to what you clicked, then looks at it (here, the thing, it and them mean whatever you last clicked) |
| `say "we need water" to the reeve` | speaks to someone |
| `I tell Nico "the sand is loud today"` | speaks to someone |
| `I nod slowly` | says the emote aloud: `*Corin nods slowly*` |
| `go to the yard and talk to Ruhl` | chains steps; after a `go`, the next step runs once you've arrived |

**Narrates.** Your actions and the world's events are retold as terse, sensory,
water-haunted prose, with italic inner thoughts and an epigraph whenever you arrive
somewhere. Every line is original, written in Herbert's manner rather than quoted from
his work. Your spoken words are never rewritten. The narrator runs from templates in the
page, so it adds no delay. Its flavour is tuned to The Glass Reach.

**Stays fast.** It pushes rather than polls:
- One warm MCP session long-polls `wait(full=true)`. The server answers the moment
  something touches you, with the full perception in the same round trip, and the
  bridge streams it to the page over SSE.
- Actions run on a second session, so they never queue behind the watcher.
- Your caption appears the instant you click or press Enter.
- Rendering resolution adapts to real GPU time, measured with timer queries.
- A small pill shows the action round-trip time, the age of the last state and the GPU
  cost per frame.

## Controls

| Key | Does |
| --- | --- |
| drag, wheel | orbit and zoom |
| click a figure, thing or the ground | target it (the ground marks "here") |
| `Enter` or `/` | type what you do (`↑` history, `↓` ideas, `Tab` completes) |
| `A` | actions tray, built from the engine's own affordances |
| `1`–`9` | go through that exit |
| `H` | switch between halftone and ASCII |
| `P` | switch between the neon and desert palettes |
| `N` | turn the narrator on or off |
| `L` | event log |
| `O` | slow orbit |

## Files

- `server.mjs`: the bridge. An MCP client over streamable HTTP and an SSE push to the page.
  No dependencies.
- `public/index.html`: the whole client (renderer, HUD, command parser, narrator) in one file.

## Credits

- [Embody](https://github.com/newsbubbles/embody) by newsbubbles (MIT), including The Glass
  Reach world, its places and its people.
- Viewer by LK Studio, released under the [MIT License](LICENSE).
