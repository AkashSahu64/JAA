import { Prisma, PrismaClient } from '@prisma/client';

export * from '@prisma/client';

const globalForPrisma = globalThis as typeof globalThis & { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export type TenantTransaction = Prisma.TransactionClient;

export async function withTenant<T>(
  userId: string,
  operation: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  if (!userId.trim()) throw new Error('A tenant userId is required');

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
    return operation(tx);
  });
}
