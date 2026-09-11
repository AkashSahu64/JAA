import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma, type TenantTransaction, withTenant } from '@jobagent/database';

export type JsonCommandValue = Prisma.InputJsonValue;

export interface IdempotentCommandResult {
  responseCode: number;
  responseBody: JsonCommandValue;
  resourceType?: string;
  resourceId?: string;
}

export interface ExecuteIdempotentCommandInput {
  userId?: string;
  scope: string;
  key: string;
  request: JsonCommandValue;
  expiresAt?: Date;
}

export class IdempotencyError extends Error {
  constructor(
    public readonly code: 'INVALID_INPUT' | 'REQUEST_CONFLICT' | 'IN_PROGRESS',
    message: string,
  ) {
    super(message);
    this.name = 'IdempotencyError';
  }
}

function canonicalize(value: JsonCommandValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const object = value as Record<string, JsonCommandValue>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(',')}}`;
}

export function hashIdempotencyRequest(request: JsonCommandValue): string {
  return createHash('sha256').update(canonicalize(request)).digest('hex');
}

function validateInput(input: ExecuteIdempotentCommandInput): void {
  if (!input.scope.trim() || !input.key.trim()) {
    throw new IdempotencyError('INVALID_INPUT', 'Idempotency scope and key are required');
  }
  if (input.expiresAt && input.expiresAt <= new Date()) {
    throw new IdempotencyError('INVALID_INPUT', 'Idempotency expiry must be in the future');
  }
}

async function executeInTransaction<T extends IdempotentCommandResult>(
  tx: TenantTransaction,
  input: ExecuteIdempotentCommandInput,
  requestHash: string,
  command: (tx: TenantTransaction) => Promise<T>,
): Promise<T & { replayed: boolean }> {
  const inserted = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO idempotency_records
      (id, "userId", scope, key, "requestHash", "expiresAt", "createdAt")
    VALUES
      (${randomUUID()}, ${input.userId ?? null}, ${input.scope}, ${input.key}, ${requestHash}, ${input.expiresAt ?? null}, now())
    ON CONFLICT ("userId", scope, key) DO NOTHING
    RETURNING id
  `;

  if (inserted.length === 0) {
    const existing = await tx.idempotencyRecord.findFirst({
      where: { userId: input.userId ?? null, scope: input.scope, key: input.key },
    });
    if (!existing) throw new IdempotencyError('IN_PROGRESS', 'Idempotency reservation changed concurrently');
    if (existing.expiresAt && existing.expiresAt <= new Date()) {
      await tx.idempotencyRecord.delete({ where: { id: existing.id } });
      return executeInTransaction(tx, input, requestHash, command);
    }
    if (existing.requestHash !== requestHash || existing.userId !== (input.userId ?? null)) {
      throw new IdempotencyError('REQUEST_CONFLICT', 'Idempotency key was used for a different request');
    }
    if (!existing.completedAt || existing.responseCode === null || existing.responseBody === null) {
      throw new IdempotencyError('IN_PROGRESS', 'The idempotent command has not completed');
    }
    return {
      responseCode: existing.responseCode,
      responseBody: existing.responseBody as JsonCommandValue,
      ...(existing.resourceType ? { resourceType: existing.resourceType } : {}),
      ...(existing.resourceId ? { resourceId: existing.resourceId } : {}),
      replayed: true,
    } as T & { replayed: boolean };
  }

  const result = await command(tx);
  await tx.idempotencyRecord.update({
    where: { id: inserted[0]!.id },
    data: {
      responseCode: result.responseCode,
      responseBody: result.responseBody,
      resourceType: result.resourceType,
      resourceId: result.resourceId,
      completedAt: new Date(),
    },
  });
  return { ...result, replayed: false };
}

export async function executeIdempotentCommand<T extends IdempotentCommandResult>(
  input: ExecuteIdempotentCommandInput,
  command: (tx: TenantTransaction) => Promise<T>,
): Promise<T & { replayed: boolean }> {
  validateInput(input);
  const requestHash = hashIdempotencyRequest(input.request);
  if (input.userId) {
    return withTenant(input.userId, (tx) => executeInTransaction(tx, input, requestHash, command));
  }
  return prisma.$transaction((tx) => executeInTransaction(tx, input, requestHash, command));
}
