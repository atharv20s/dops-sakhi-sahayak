// ==============================================================================
//  Sakhi Sahayak — PostgreSQL Database Client (Prisma)
// ==============================================================================
const { PrismaClient } = require('@prisma/client');

let prismaInstance = null;

function getPrisma() {
  if (!prismaInstance) {
    prismaInstance = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }
  return prismaInstance;
}

/**
 * Checks PostgreSQL database connectivity by executing a raw SELECT 1.
 * Used by the /ready readiness probe.
 * @returns {Promise<{ ok: boolean, latencyMs?: number, error?: string }>}
 */
async function checkDatabaseHealth() {
  if (!process.env.DATABASE_URL) {
    return { ok: false, error: 'DATABASE_URL is not configured' };
  }

  const start = Date.now();
  try {
    const client = getPrisma();
    await client.$queryRawUnsafe('SELECT 1');
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err.message, latencyMs: Date.now() - start };
  }
}

module.exports = {
  prisma: getPrisma(),
  getPrisma,
  checkDatabaseHealth,
  isDatabaseConfigured: () => Boolean(process.env.DATABASE_URL)
};
