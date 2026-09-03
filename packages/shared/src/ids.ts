/**
 * ULID-style identifiers with bai prefixes (`ses_01J…`, `msg_…`, …).
 * 26 Crockford-base32 chars: 10 time + 16 randomness. Sortable by creation.
 */

const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type SessionId = Brand<string, "ses">;
export type MessageId = Brand<string, "msg">;
export type PartId = Brand<string, "part">;
export type InputId = Brand<string, "inp">;
export type RunId = Brand<string, "run">;
export type PermissionRequestId = Brand<string, "perm">;
export type QuestionRequestId = Brand<string, "que">;
export type JobId = Brand<string, "job">;
export type AssetId = Brand<string, "ast">;

/** 80 bits of randomness as a bigint. */
function randomBits(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let acc = 0n;
  for (const byte of bytes) acc = (acc << 8n) | BigInt(byte);
  return acc;
}

function encodeRandom(bits: bigint): string {
  let out = "";
  let value = bits;
  for (let i = 0; i < 16; i++) {
    out = ENC[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

const MAX_RANDOM = (1n << 80n) - 1n;

// Monotonic state: within the same millisecond, increment the random part so
// ulids are always strictly increasing (creation order == sort order).
let lastTime = 0;
let lastRandom: bigint | undefined;

/** Generate a monotonic ULID. */
export function ulid(time: number = Date.now()): string {
  let randomPart: bigint;
  if (time === lastTime && lastRandom !== undefined) {
    randomPart = (lastRandom + 1n) & MAX_RANDOM;
  } else {
    randomPart = randomBits();
  }
  lastTime = time;
  lastRandom = randomPart;

  let t = time;
  let timePart = "";
  for (let i = 0; i < 10; i++) {
    timePart = ENC[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  return timePart + encodeRandom(randomPart);
}

export function isPrefixed(id: string, prefix: string): boolean {
  return id.length === prefix.length + 1 + 26 && id.startsWith(`${prefix}_`);
}

export const newId = {
  session(): SessionId {
    return `ses_${ulid()}` as SessionId;
  },
  message(): MessageId {
    return `msg_${ulid()}` as MessageId;
  },
  part(): PartId {
    return `part_${ulid()}` as PartId;
  },
  input(): InputId {
    return `inp_${ulid()}` as InputId;
  },
  run(): RunId {
    return `run_${ulid()}` as RunId;
  },
  permissionRequest(): PermissionRequestId {
    return `perm_${ulid()}` as PermissionRequestId;
  },
  questionRequest(): QuestionRequestId {
    return `que_${ulid()}` as QuestionRequestId;
  },
  job(): JobId {
    return `job_${ulid()}` as JobId;
  },
  asset(): AssetId {
    return `ast_${ulid()}` as AssetId;
  },
};
