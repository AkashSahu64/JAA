import { Prisma, PrismaClient } from '@prisma/client';

export * from '@prisma/client';

const globalForPrisma = globalThis as typeof globalThis & { prisma?: PrismaClient; servicePrisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export type TenantTransaction = Prisma.TransactionClient;

/** Internal maintenance boundary; request handlers must use withTenant. */
export async function withService<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_ADMIN_URL?.trim();
  if (!url) throw new Error('DATABASE_ADMIN_URL is required for service maintenance operations');
  const servicePrisma = globalForPrisma.servicePrisma ?? new PrismaClient({ datasources: { db: { url } } });
  globalForPrisma.servicePrisma = servicePrisma;
  return servicePrisma.$transaction(operation);
}

/** Release the separately configured maintenance connection during shutdown. */
export async function disconnectService(): Promise<void> {
  const servicePrisma = globalForPrisma.servicePrisma;
  if (!servicePrisma) return;
  globalForPrisma.servicePrisma = undefined;
  await servicePrisma.$disconnect();
}

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
