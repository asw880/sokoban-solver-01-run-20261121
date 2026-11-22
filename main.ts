// sokoban-solver: a push-optimal Sokoban solver, written for make.fun's
// sokoban-solver-01 bounty. One program answers a whole set of levels.
//
// How it works:
//   - Search runs over PUSHES, not moves. Between pushes the player walks
//     freely, so a state is the boxes' squares plus the region the player
//     can reach (named by its lowest square). Expanding states in order of
//     pushes made makes the first solved state push-optimal.
//   - Two deadlocks are pruned, and neither can kill a solvable state:
//     a box on a dead square (one from which no push can ever reach a goal)
//     and a box inside a frozen 2x2 block of walls and boxes.
//   - Levels from this generator split into independent rooms: a box pushed
//     out of its room through its door can never come back, so each room is
//     solved on its own from its door and the push counts add up. The
//     solver finds the rooms by cutting the hallway (the dead squares of
//     the player's row) out of the floor. A level that does not split cleanly
//     falls back to one search over the whole board.
//   - Pure and deterministic: no clock, no randomness, fixed direction
//     order, FIFO queue. Two runs write the same bytes. Work is bounded by
//     a state count per search, never by time.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The most states one push search keeps before it gives up. Work, never the clock. */
const MAX_STATES = 250_000;

/** The four moves: dx, dy, the step's letter and the push's letter. */
const DIRS = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
] as const;

interface Level {
  w: number;
  h: number;
  /** 1 is a wall, 0 is open floor. */
  wall: Uint8Array;
  goals: number[];
  /** Sorted. */
  boxes: number[];
  player: number;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '#') continue;
      const i = y * w + x;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever the text shows: nothing leaves the board.
  for (let x = 0; x < w; x++) {
    wall[x] = 1;
    wall[(h - 1) * w + x] = 1;
  }
  for (let y = 0; y < h; y++) {
    wall[y * w] = 1;
    wall[y * w + (w - 1)] = 1;
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares a box can stand on and still be pushed onto some goal:
 * pull back from the goals. From a live square x, the square y = x - d
 * is live when y is open and the player could stand at y - d to push from.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const d of DIRS) {
      const step = d.dy * w + d.dx;
      const y = x - step;
      if (wall[y] === 0 && wall[y - step] === 0 && live[y] === 0) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood the region the player reaches from `from` with `blocked` (boxes) in
 * the way, marking it in `seen` with `stamp`. Returns the region's lowest
 * square, which names the region: two states with the same boxes and the
 * same lowest reachable square are the same state.
 */
function floodLow(
  level: Level,
  blocked: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const up = p - w;
    const down = p + w;
    const left = p - 1;
    const right = p + 1;
    if (wall[up] === 0 && blocked[up] === 0 && seen[up] !== stamp) {
      seen[up] = stamp;
      stack[n++] = up;
    }
    if (wall[down] === 0 && blocked[down] === 0 && seen[down] !== stamp) {
      seen[down] = stamp;
      stack[n++] = down;
    }
    if (wall[left] === 0 && blocked[left] === 0 && seen[left] !== stamp) {
      seen[left] = stamp;
      stack[n++] = left;
    }
    if (wall[right] === 0 && blocked[right] === 0 && seen[right] !== stamp) {
      seen[right] = stamp;
      stack[n++] = right;
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block: four
 * squares of walls and boxes, with a box among them off its goal. Such a
 * box can never move again, so the state is dead.
 */
function frozenBlock(level: Level, blocked: Uint8Array, isGoal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  const filled = (s: number): boolean => wall[s] === 1 || blocked[s] === 1;
  const offGoal = (s: number): boolean => blocked[s] === 1 && isGoal[s] === 0;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!filled(a) || !filled(b) || !filled(c) || !filled(d)) continue;
    if (offGoal(a) || offGoal(b) || offGoal(c) || offGoal(d)) return true;
  }
  return false;
}

/** A state's key: the region's lowest square, then the boxes, as digits in base `size`. */
function stateKey(boxes: number[], regionLow: number, size: number): number {
  let k = regionLow;
  for (const b of boxes) k = k * size + b;
  return k;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function shortestWalk(level: Level, blocked: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const { w, wall } = level;
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const d of DIRS) {
      const q = p + d.dy * w + d.dx;
      if (wall[q] === 1 || blocked[q] === 1 || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = d.step;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('shortestWalk: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The player's square after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOfMoves(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    if (ch === 'u') p -= w;
    else if (ch === 'd') p += w;
    else if (ch === 'l') p -= 1;
    else if (ch === 'r') p += 1;
  }
  return p;
}

/**
 * The push-optimal solution of `level`: { pushes, moves } (moves in LURD, a
 * lower letter a step and an upper one a push), or null when the search gives
 * up or the level has no solution. `exitSquare` is a square the player must
 * still be able to reach once the boxes are home (the door out of a room);
 * null when no exit is needed, as for the last room of a level.
 */
function solvePushes(
  level: Level,
  maxStates: number,
  exitSquare: number | null,
): { pushes: number; moves: string } | null {
  const { w, wall, goals, boxes: startBoxes, player: startPlayer } = level;
  const size = wall.length;
  const isGoal = new Uint8Array(size);
  for (const g of goals) isGoal[g] = 1;
  const live = liveSquares(level);
  const blocked = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (bs: number[]): boolean => bs.every((b) => isGoal[b] === 1);
  if (startBoxes.some((b) => live[b] === 0)) return null;
  if (solved(startBoxes)) return { pushes: 0, moves: '' };

  // States in the order found: their boxes, the player's square after the
  // push that made them, and their parent. The open list is a plain queue,
  // so states leave it in order of pushes made.
  const allBoxes: number[][] = [startBoxes];
  const allPlayer: number[] = [startPlayer];
  const parent: number[] = [-1];
  const visited = new Map<number, number>();
  for (const b of startBoxes) blocked[b] = 1;
  const startLow = floodLow(level, blocked, startPlayer, seen, ++stamp, stack);
  for (const b of startBoxes) blocked[b] = 0;
  visited.set(stateKey(startBoxes, startLow, size), 0);

  // Can the player still reach `exitSquare` from `from` with `boxes` as obstacles?
  const canExit = (boxes: number[], from: number): boolean => {
    if (exitSquare === null) return true;
    for (const b of boxes) blocked[b] = 1;
    floodLow(level, blocked, from, mark, ++stamp, stack);
    for (const b of boxes) blocked[b] = 0;
    return mark[exitSquare] === stamp;
  };

  let found = -1;
  for (let head = 0; found < 0 && head < allBoxes.length; head++) {
    const boxes = allBoxes[head];
    for (const b of boxes) blocked[b] = 1;
    floodLow(level, blocked, allPlayer[head], seen, ++stamp, stack);
    const regionStamp = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (const d of DIRS) {
        const step = d.dy * w + d.dx;
        const t = b + step;
        const behind = b - step;
        if (seen[behind] !== regionStamp) continue;
        if (wall[t] === 1 || blocked[t] === 1) continue;
        if (live[t] === 0) continue;
        blocked[b] = 0;
        blocked[t] = 1;
        const frozen = frozenBlock(level, blocked, isGoal, t);
        let key = -1;
        let nextBoxes: number[] | null = null;
        if (!frozen) {
          nextBoxes = boxes.slice();
          nextBoxes[bi] = t;
          nextBoxes.sort((x, y) => x - y);
          const newLow = floodLow(level, blocked, b, mark, ++stamp, stack);
          key = stateKey(nextBoxes, newLow, size);
        }
        blocked[t] = 0;
        blocked[b] = 1;
        if (frozen || visited.has(key)) continue;
        if (allBoxes.length >= maxStates) {
          for (const x of boxes) blocked[x] = 0;
          return null;
        }
        visited.set(key, allBoxes.length);
        allBoxes.push(nextBoxes!);
        allPlayer.push(b);
        parent.push(head);
        if (solved(nextBoxes!) && canExit(nextBoxes!, b)) {
          found = allBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) blocked[x] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = startPlayer;
  let boxes = startBoxes;
  for (const s of path) {
    const nextBoxes = allBoxes[s];
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const step = to - from;
    const dir = DIRS.find((d) => d.dy * w + d.dx === step)!;
    for (const b of boxes) blocked[b] = 1;
    moves += shortestWalk(level, blocked, player, from - step);
    for (const b of boxes) blocked[b] = 0;
    moves += dir.push;
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room. Null when some part holds more or fewer boxes than
 * goals, or a box starts in the hallway: then the level is no set of rooms.
 */
function splitRooms(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (wall[i] === 0 && live[i] === 0) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b] === 1)) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] === 1 || cut[s] === 1 || part[s] >= 0) continue;
    const squares: number[] = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const d of DIRS) {
        const q = squares[i] + d.dy * w + d.dx;
        if (wall[q] === 0 && cut[q] === 0 && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) {
    const r = part[b];
    if (r < 0) return null;
    rooms[r].boxes.push(b);
  }
  for (const g of goals) {
    const r = part[g];
    if (r < 0) return null;
    rooms[r].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level's moves: each room's push-optimal solution in turn, the other
 * rooms' boxes standing as walls (on their goals once their room is done),
 * the player walking on from where the last room left it. A box never leaves
 * its room, so the rooms' optima add up to the level's. Null when a room's
 * search gives up, or the level is no set of rooms and the search over the
 * whole level gives up.
 */
function solveLevel(level: Level): string {
  const rooms = splitRooms(level);
  if (rooms === null) {
    const whole = solvePushes(level, MAX_STATES, null);
    return whole === null ? '' : whole.moves;
  }
  const hallwayRow = Math.floor(level.player / level.w);
  let player = level.player;
  let moves = '';
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri];
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      const standing = other.done ? other.goals : other.boxes;
      for (const b of standing) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    // The door out of this room is its square on the hallway row. Every
    // room but the last must leave the player able to reach it, or the
    // player is trapped and the next room can never be reached.
    const door = ri === rooms.length - 1
      ? null
      : room.squares.find((s) => Math.floor(s / level.w) === hallwayRow) ?? null;
    const solved = solvePushes(sub, MAX_STATES, door);
    if (solved === null) return '';
    moves += solved.moves;
    player = endOfMoves(level.w, player, solved.moves);
    room.done = true;
  }
  return moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8')));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
