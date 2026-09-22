# Thu'um Online's fork of SkyMP

This is a fork of [skyrim-multiplayer/skymp](https://github.com/skyrim-multiplayer/skymp), taken
from upstream commit [`f926944b`](https://github.com/skyrim-multiplayer/skymp/tree/f926944b18e3aed4bc3864ce668626c05ec2545f)
and built from upstream only. It exists to publish the modifications Thu'um Online ships to its
players, as GPL-3.0 requires.

Upstream is the real project. If you want SkyMP, go there.

## What this fork changes

**Four TypeScript files. No deletions. No C++, no CMake, no changes to Skyrim Platform.**

Thirty-one added lines across the three upstream files below, plus a new 165-line service. Counting
this file and a `.gitignore` line, the whole branch is six files and 285 added lines against
upstream.

| file | change |
|---|---|
| `skymp5-client/src/services/services/seatGateService.ts` | **new** — the seat gate |
| `skymp5-client/src/services/services/remoteServer.ts` | defer `onCreateActorMessage` for `isMe` while the gate holds |
| `skymp5-client/src/services/services/authService.ts` | don't clear the browser page while the gate holds |
| `skymp5-client/src/index.ts` | register the service |

### Why

Stock SkyMP seats a character the moment a connection is accepted. Stock spawn takes
`getActorsByProfileId(profileId)[0]` — the lowest form id — and a gamemode cannot opt out of it:
`spawnAllowed` is emitted on an `EventEmitter` the gamemode cannot reach, and `mp.removeListener`
is not exposed. `setUserActor` then sends a `CreateActorMessage` with `isMe`, and `RemoteServer`
calls `loadGame` immediately. By the time a player could be asked which of their characters they
want, they are already standing in the world as one of them.

Correcting it afterwards costs a second `setUserActor`, and therefore a second `loadGame`, and
therefore a second loading screen. That is the one thing no amount of gamemode code can fix, and
it is the only reason this fork exists.

### How

While the gate is holding, an `isMe` message is kept rather than acted on, so the player stays at
the main menu with the browser page up — which is where character select belongs. When the realm
releases the gate, **the most recent held message is the one that runs.**

That last part is the whole trick: stock spawn still seats `[0]` and still sends its message, it is
simply never loaded. The realm then seats the character the player actually chose, and only that
message reaches `loadGame`. One loading screen, and it is the right character — without the fork
needing any power to stop stock spawn from running.

A hold expires after three minutes and seats the last character anyway, loudly. A gate that can
only be opened from outside is otherwise a way to strand a player at a menu forever.

### It is off unless a server asks for it

The gate reads **one field name** — `seatGate` — out of custom packets, with two values, `hold` and
`release`. Nothing holds unless a server sends them, so this build against an ordinary SkyMP server
behaves exactly like an unmodified one.

That narrowness is deliberate. This client does not know what a character is, what a slot is, or
what the realm allows; all of that lives behind the `mp` API in a separate, private gamemode. A
client that understood the realm's schema would drag that design into a GPL-3.0 repository. It
waits for a signal; it does not understand one.

## Licence

Everything here is under its upstream licence. `skymp5-client`, `skyrim-platform` and
`skymp5-scripts` are **GPL-3.0**; `skymp5-server` is **AGPL-3.0**; `libespm`, `papyrus-vm`,
`skymp5-functions-lib` and `viet` are MIT. See each subproject's `LICENSE`.

Thu'um Online ships a modified `skymp5-client` to players. This repository is the corresponding
source for those modifications, offered under GPL-3.0 section 6. The client builds we ship carry a
pointer to it in `Data/Platform/Distribution/ThuumOnline-licences`.

**The server is not modified.** Thu'um Online runs stock upstream `f926944b`, and its gamemode is a
separate work written against the documented `mp` API. No part of it is in this repository.

## Building the client

TypeScript and webpack only — you do not need the C++ toolchain to build the part we modified:

```
cd skymp5-client
npm install
npm run build
```

Output: `build/dist/client/Data/Platform/Plugins/skymp5-client.js`.

Upstream's lockfile is `yarn.lock`, and it is left exactly as upstream has it. The builds we ship
were produced with `npm install`, which resolves from `package.json` rather than that lockfile, so
dependency versions are not pinned byte-for-byte to upstream's. Said here rather than left for
somebody to discover from a diff that will not reproduce.
