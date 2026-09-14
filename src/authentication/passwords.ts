import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// scrypt rather than a native argon2 binding: it ships with Node, so it adds no
// dependency and no install script. The cost is one of OWASP's equivalent
// scrypt configurations (N=2^15, r=8, p=3), all of which match N=2^17, r=8, p=1.
const COST = { N: 2 ** 15, r: 8, p: 3 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

function derive(password: string, salt: Buffer, cost: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // scrypt needs 128 * N * r bytes, which exceeds Node's 32 MiB default.
    const maxmem = 256 * (cost.N ?? 0) * (cost.r ?? 0);
    scrypt(password, salt, KEY_LENGTH, { ...cost, maxmem }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Encodes as `scrypt$N$r$p$salt$key`, so a later change of cost still verifies old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, COST);
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64"), key.toString("base64")].join(
    "$",
  );
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = encoded.split("$");
  if (scheme !== "scrypt" || salt === undefined || key === undefined) {
    return false;
  }

  const expected = Buffer.from(key, "base64");
  const actual = await derive(password, Buffer.from(salt, "base64"), {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Verifying against this when there is no account to verify against makes an
// unknown username cost the same work as a wrong password, so response time
// does not reveal which usernames exist. That holds only while stored hashes
// share the decoy's cost: if COST is raised, rehash existing passwords on their
// next successful sign-in, or old accounts will verify measurably faster.
const decoy = hashPassword(randomBytes(SALT_LENGTH).toString("base64"));

export async function spendVerificationEffort(password: string): Promise<void> {
  await verifyPassword(password, await decoy);
}
