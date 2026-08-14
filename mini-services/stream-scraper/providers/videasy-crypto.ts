/**
 * Videasy / Vidking `enc=2` payload crypto.
 *
 * Extracted from www.vidking.net VideoPlayer (magic `mvm1`). Seed comes from
 * `GET {api}/seed?mediaId={tmdbId}`; decrypt is XOR with a custom PRNG keyed
 * by that seed + the TMDB id.
 */

const MAGIC = [109, 118, 109, 49] as const;
const HL = [
  1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993,
  2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987,
  1925078388, 2162078206, 2614888103, 3248222580,
] as const;
const H0 = [1732584193, 4023233417, 2562383102, 271733878] as const;
const TABLE_SIZE = 61;
const MIX_ROUNDS = 8;
const GOLDEN = 2654435769;

function isEvenTriangle(n: number): boolean {
  return ((n * (n + 1)) & 1) === 0;
}

function isOddLength(n: number): boolean {
  return ((n * (n + 1)) & 1) === 1;
}

function avalanche(n: number): number {
  let x = n >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 2246822507) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 3266489909) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function rotl(n: number, bits: number): number {
  const x = n >>> 0;
  const s = bits & 31;
  if (s === 0) return x >>> 0;
  return ((x << s) | (x >>> (32 - s))) >>> 0;
}

function mixString(input: string): number {
  let acc = H0[0] >>> 0;
  for (let i = 0; i < input.length; i++) {
    acc = rotl((acc ^ Math.imul(input.charCodeAt(i), HL[i & 15])) >>> 0, 5);
  }
  return avalanche(acc);
}

function rc4Table(key: string): number[] {
  const table = new Array<number>(256);
  for (let i = 0; i < 256; i++) table[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + table[i]! + key.charCodeAt(i % key.length)) & 255;
    const tmp = table[i]!;
    table[i] = table[j]!;
    table[j] = tmp;
  }
  return table;
}

function fnv(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash = Math.imul(hash ^ input.charCodeAt(i), 16777619) >>> 0;
  }
  return avalanche(hash);
}

function mix3(a: number, b: number, c: number): number {
  return ((a ^ b) >>> 0 | (a & b & c) >>> 0) >>> 0;
}

interface PrngState {
  S: number[];
  acc: number;
}

function initPrng(seed: string, mediaId: number): PrngState {
  if (isOddLength(seed.length)) {
    return { S: rc4Table(seed), acc: mixString(seed) };
  }
  const table = new Array<number>(TABLE_SIZE);
  let acc = avalanche(fnv(seed) ^ avalanche((mediaId >>> 0) ^ GOLDEN)) >>> 0;
  for (let i = 0; i < MIX_ROUNDS; i++) {
    if (isEvenTriangle(i)) {
      const slot = acc % TABLE_SIZE;
      acc = rotl((acc + GOLDEN) >>> 0, 7 + (i & 7));
      table[slot] = (acc ^ avalanche(acc)) >>> 0;
      acc = avalanche((acc + slot) >>> 0);
    } else {
      table[i] = HL[i & 15];
    }
  }
  return { S: table, acc: avalanche(acc ^ 2779096485) >>> 0 };
}

function nextWord(state: PrngState, index: number): number {
  const table = state.S;
  let acc = state.acc;
  const slot = acc % TABLE_SIZE;
  const present = 0 - +(slot in table);
  const cell = (table[slot] ?? 0) >>> 0;
  const mixed = Math.imul(GOLDEN, index + 1) >>> 0;
  let word = mix3(acc, (cell ^ mixed) >>> 0, present);
  word =
    (rotl((word + acc) >>> 0, slot & 31) ^ rotl(acc, Math.imul(slot, 7) & 31)) >>>
    0;
  acc = avalanche((word + GOLDEN) >>> 0);
  table[slot] = acc >>> 0;
  state.acc = acc;
  return acc >>> 0;
}

function keystream(seed: string, mediaId: number, length: number): Uint8Array {
  const state = initPrng(seed, mediaId);
  const out = new Uint8Array(length);
  let n = 0;
  for (let i = 0; i < length; ) {
    const word = nextWord(state, n++);
    out[i++] = word & 255;
    if (i < length) out[i++] = (word >>> 8) & 255;
    if (i < length) out[i++] = (word >>> 16) & 255;
    if (i < length) out[i++] = (word >>> 24) & 255;
  }
  return out;
}

function decodeBase64Url(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  const b64 = padded + "=".repeat(padLen);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function xorBytes(data: Uint8Array, seed: string, mediaId: number): Uint8Array {
  const key = keystream(seed, mediaId, data.length);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i]! ^ key[i]!;
  return out;
}

/** Decrypt a Videasy `enc=2` body. Throws if the magic prefix does not match. */
export function decryptVideasyPayload(
  payload: string,
  seed: string,
  mediaId: number
): string {
  const xored = xorBytes(decodeBase64Url(payload), seed, mediaId);
  for (let i = 0; i < MAGIC.length; i++) {
    if (xored[i] !== MAGIC[i]) {
      throw new Error("videasy decrypt failed: bad seed or tampered payload");
    }
  }
  return new TextDecoder("utf-8").decode(xored.subarray(MAGIC.length));
}

/** Test helper — reverse of `decryptVideasyPayload`. */
export function encryptVideasyPayload(
  plaintext: string,
  seed: string,
  mediaId: number
): string {
  const raw = new TextEncoder().encode(plaintext);
  const framed = new Uint8Array(MAGIC.length + raw.length);
  framed.set(MAGIC, 0);
  framed.set(raw, MAGIC.length);
  return encodeBase64Url(xorBytes(framed, seed, mediaId));
}
