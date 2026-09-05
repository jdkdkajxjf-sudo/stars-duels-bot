import { PrismaClient } from '@prisma/client'

// Устанавливаем DATABASE_URL напрямую (если не задан)
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://postgres.izxodeqeofxkyeluymvz:wp8dZOTICPfYBCBQ@aws-0-eu-central-1.pooler.supabase.com:5432/postgres'
}

const globalForPrisma = globalThis as unknown as {
  prismaDuels: PrismaClient | undefined
}

export const db =
  globalForPrisma.prismaDuels ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prismaDuels = db
