import { createRequire } from 'module';
import { describe, it, expect, vi } from 'vitest';

const require = createRequire(import.meta.url);

describe('seed-admin docker helper', () => {
    it('requires an explicit admin password when the admin does not exist', async () => {
        const prisma = {
            user: {
                findUnique: vi.fn().mockResolvedValue(null),
                create: vi.fn(),
                update: vi.fn(),
            },
        };
        const { seedAdmin } = require('../../../../scripts/seed-admin.js');

        await expect(seedAdmin({ prisma, hash: vi.fn(), adminPassword: undefined }))
            .rejects.toThrow(/ADMIN_PASSWORD/);
        expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('creates the admin with the explicitly configured strong password', async () => {
        const createdUsers: unknown[] = [];
        const prisma = {
            user: {
                findUnique: vi.fn().mockResolvedValue(null),
                create: vi.fn().mockImplementation(async ({ data }) => {
                    createdUsers.push(data);
                    return { email: data.email };
                }),
                update: vi.fn(),
            },
        };
        const hash = vi.fn().mockResolvedValue('hashed-password');
        const { seedAdmin } = require('../../../../scripts/seed-admin.js');

        const result = await seedAdmin({
            prisma,
            hash,
            adminPassword: 'a-strong-initial-admin-password',
        });

        expect(result).toEqual({ action: 'created', email: 'admin@localhost' });
        expect(hash).toHaveBeenCalledWith('a-strong-initial-admin-password', 12);
        expect(prisma.user.create).toHaveBeenCalledWith({
            data: {
                email: 'admin@localhost',
                password: 'hashed-password',
                name: 'Admin',
                role: 'admin',
                isActive: true,
                educationStage: 'junior_high',
                enrollmentYear: 2025,
            },
        });
        expect(createdUsers).toHaveLength(1);
    });

    it('rotates an existing legacy default password before allowing startup', async () => {
        const prisma = {
            user: {
                findUnique: vi.fn().mockResolvedValue({
                    email: 'admin@localhost',
                    password: 'legacy-default-hash',
                    educationStage: 'junior_high',
                    enrollmentYear: 2025,
                }),
                create: vi.fn(),
                update: vi.fn().mockResolvedValue({ email: 'admin@localhost' }),
            },
        };
        const hash = vi.fn().mockResolvedValue('new-secure-hash');
        const compare = vi.fn().mockResolvedValue(true);
        const { seedAdmin } = require('../../../../scripts/seed-admin.js');

        await seedAdmin({
            prisma,
            hash,
            compare,
            adminPassword: 'a-strong-rotated-admin-password',
        });

        expect(compare).toHaveBeenCalledWith('123456', 'legacy-default-hash');
        expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ password: 'new-secure-hash' }),
        }));
    });

    it('updates default education fields when the admin user already exists', async () => {
        const prisma = {
            user: {
                findUnique: vi.fn().mockResolvedValue({ email: 'admin@localhost', educationStage: 'senior_high', enrollmentYear: 2024 }),
                create: vi.fn(),
                update: vi.fn().mockResolvedValue({ email: 'admin@localhost' }),
            },
        };
        const hash = vi.fn();
        const { seedAdmin } = require('../../../../scripts/seed-admin.js');

        const result = await seedAdmin({ prisma, hash });

        expect(result).toEqual({ action: 'updated', email: 'admin@localhost' });
        expect(hash).not.toHaveBeenCalled();
        expect(prisma.user.create).not.toHaveBeenCalled();
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { email: 'admin@localhost' },
            data: {
                role: 'admin',
                isActive: true,
                educationStage: 'senior_high',
                enrollmentYear: 2024,
            },
        });
    });

    it('preserves existing education fields when admin user has them set', async () => {
        const prisma = {
            user: {
                findUnique: vi.fn().mockResolvedValue({ email: 'admin@localhost' }),
                create: vi.fn(),
                update: vi.fn().mockResolvedValue({ email: 'admin@localhost' }),
            },
        };
        const hash = vi.fn();
        const { seedAdmin } = require('../../../../scripts/seed-admin.js');

        const result = await seedAdmin({ prisma, hash });

        expect(result).toEqual({ action: 'updated', email: 'admin@localhost' });
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { email: 'admin@localhost' },
            data: {
                role: 'admin',
                isActive: true,
                educationStage: 'junior_high',
                enrollmentYear: 2025,
            },
        });
    });

    it('restores admin role when user role was reset to user', async () => {
        const prisma = {
            user: {
                findUnique: vi.fn().mockResolvedValue({
                    email: 'admin@localhost',
                    role: 'user', // Role was reset by migration
                    isActive: true,
                    educationStage: 'senior_high',
                    enrollmentYear: 2024,
                }),
                create: vi.fn(),
                update: vi.fn().mockResolvedValue({ email: 'admin@localhost' }),
            },
        };
        const hash = vi.fn();
        const { seedAdmin } = require('../../../../scripts/seed-admin.js');

        const result = await seedAdmin({ prisma, hash });

        expect(result).toEqual({ action: 'updated', email: 'admin@localhost' });
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { email: 'admin@localhost' },
            data: {
                role: 'admin', // Should restore admin role
                isActive: true,
                educationStage: 'senior_high',
                enrollmentYear: 2024,
            },
        });
    });

    it('reactivates admin when isActive was set to false', async () => {
        const prisma = {
            user: {
                findUnique: vi.fn().mockResolvedValue({
                    email: 'admin@localhost',
                    role: 'admin',
                    isActive: false, // Account was disabled
                    educationStage: 'junior_high',
                    enrollmentYear: 2025,
                }),
                create: vi.fn(),
                update: vi.fn().mockResolvedValue({ email: 'admin@localhost' }),
            },
        };
        const hash = vi.fn();
        const { seedAdmin } = require('../../../../scripts/seed-admin.js');

        const result = await seedAdmin({ prisma, hash });

        expect(result).toEqual({ action: 'updated', email: 'admin@localhost' });
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { email: 'admin@localhost' },
            data: {
                role: 'admin',
                isActive: true, // Should reactivate account
                educationStage: 'junior_high',
                enrollmentYear: 2025,
            },
        });
    });

    it('restores both role and isActive when both were corrupted', async () => {
        const prisma = {
            user: {
                findUnique: vi.fn().mockResolvedValue({
                    email: 'admin@localhost',
                    role: 'user', // Downgraded
                    isActive: false, // Disabled
                    educationStage: 'senior_high',
                    enrollmentYear: 2024,
                }),
                create: vi.fn(),
                update: vi.fn().mockResolvedValue({ email: 'admin@localhost' }),
            },
        };
        const hash = vi.fn();
        const { seedAdmin } = require('../../../../scripts/seed-admin.js');

        const result = await seedAdmin({ prisma, hash });

        expect(result).toEqual({ action: 'updated', email: 'admin@localhost' });
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { email: 'admin@localhost' },
            data: {
                role: 'admin', // Restore admin role
                isActive: true, // Reactivate account
                educationStage: 'senior_high',
                enrollmentYear: 2024,
            },
        });
    });
});
