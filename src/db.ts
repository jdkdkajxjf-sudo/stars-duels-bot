import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prismaDuels: PrismaClient | undefined
}

export const db =
  globalForPrisma.prismaDuels ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prismaDuels = db
