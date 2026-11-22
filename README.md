# Sokoban solver

A push-optimal Sokoban solver, written for make.fun's
`sokoban-solver-01-run-20261121` bounty.

## How it works

Search runs over **pushes**, not moves. Between pushes the player walks
freely, so a state is the boxes' squares plus the region the player can
reach (named by its lowest square). States leave the queue in order of
pushes made, so the first solved state is push-optimal.

Two deadlocks are pruned, and neither can kill a solvable state: a box on
a **dead square** (one from which no push can ever reach a goal) and a box
inside a **frozen 2x2 block** of walls and boxes.

Levels from this generator split into independent rooms: a box pushed out
of its room through its door can never come back, so each room is solved on
its own from its door and the push counts add up. The solver finds the rooms
by cutting the hallway (the dead squares of the player's row) out of the
floor. A level that does not split cleanly falls back to one search over the
whole board. Every room but the last must leave the player able to reach its
door, or the next room could never be reached.

Pure and deterministic: no clock, no randomness, fixed direction order, FIFO
queue. Two runs write the same bytes. Work is bounded by a state count per
search, never by time.

## Layout

- `main.ts` — the whole program: parse, search, room split, I/O.
- `LICENSE` — MIT.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`) and writes
`/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`) for every instance.
