import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SEED_USER_ID = '00000000-0000-4000-8000-000000000001';
const SEED_PROFILE_ID = '00000000-0000-4000-8000-000000000002';
const SEED_SEARCH_ID = '00000000-0000-4000-8000-000000000003';
const SEED_RESUME_ID = '00000000-0000-4000-8000-000000000004';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The deterministic development seed cannot run in production.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.upsert({
      where: { id: SEED_USER_ID },
      update: { name: 'Example Candidate', isActive: true },
      create: {
        id: SEED_USER_ID,
        email: 'candidate@example.invalid',
        passwordHash: '$2b$12$DUMMYHASHFORLOCALFIXTUREONLY000000000000000000000000000',
        name: 'Example Candidate',
      },
    });

    await tx.userProfile.upsert({
      where: { userId: SEED_USER_ID },
      update: {},
      create: {
        id: SEED_PROFILE_ID,
        userId: SEED_USER_ID,
        fullName: 'Example Candidate',
        email: 'candidate@example.invalid',
        yearsOfExperience: 0,
        targetRoles: ['Software Engineer'],
        skills: { programming: ['TypeScript'] },
      },
    });

    await tx.searchProfile.upsert({
      where: { id: SEED_SEARCH_ID },
      update: {},
      create: {
        id: SEED_SEARCH_ID,
        userId: SEED_USER_ID,
        name: 'Example search',
        targetRoles: ['Software Engineer'],
        sources: ['fixture'],
        maxApplicationsPerDay: 5,
        isActive: false,
      },
    });

    await tx.resume.upsert({
      where: { id: SEED_RESUME_ID },
      update: {},
      create: {
        id: SEED_RESUME_ID,
        userId: SEED_USER_ID,
        name: 'Example master resume',
        isMaster: true,
        content: 'Deterministic fixture only. Replace with approved candidate facts.',
      },
    });
  });
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
