import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/** SQLite's unique email index is case-sensitive; use COLLATE NOCASE for legacy mixed-case rows. */
export async function findCaseInsensitiveUserId(email: string): Promise<string | null> {
    const normalized = email.trim().toLowerCase();
    const rows = await prisma.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM "User" WHERE email = ${normalized} COLLATE NOCASE LIMIT 1`
    );
    return rows[0]?.id ?? null;
}
