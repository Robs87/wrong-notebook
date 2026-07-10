const { PrismaClient } = require('@prisma/client');
const { compare, hash } = require('bcryptjs');

const DEFAULT_ADMIN = {
    email: 'admin@localhost',
    password: '123456',
    name: 'Admin',
    role: 'admin',
    isActive: true,
    educationStage: 'junior_high',
    enrollmentYear: 2025,
};

const WEAK_ADMIN_PASSWORDS = new Set([
    DEFAULT_ADMIN.password,
    'password',
    'admin',
    'changeme',
    'change_me_with_a_strong_password',
]);

function requireStrongAdminPassword(password, allowWeak = false) {
    if (!password) {
        throw new Error(
            'ADMIN_PASSWORD is required for a new install or when rotating the legacy default password.'
        );
    }
    if (!allowWeak && (password.length < 12 || WEAK_ADMIN_PASSWORDS.has(password))) {
        throw new Error('ADMIN_PASSWORD must be at least 12 characters and must not be a known default.');
    }
    return password;
}

async function seedAdmin({
    prisma,
    hash: hashPassword,
    compare: comparePassword = compare,
    adminPassword = process.env.ADMIN_PASSWORD,
    allowWeak = process.env.ADMIN_PASSWORD_ALLOW_WEAK === 'true',
}) {
    const existingUser = await prisma.user.findUnique({
        where: { email: DEFAULT_ADMIN.email },
    });

    if (existingUser) {
        const updateData = {
            role: DEFAULT_ADMIN.role,
            isActive: DEFAULT_ADMIN.isActive,
            educationStage: existingUser.educationStage ?? DEFAULT_ADMIN.educationStage,
            enrollmentYear: existingUser.enrollmentYear ?? DEFAULT_ADMIN.enrollmentYear,
        };

        // 只轮换仍使用历史默认口令的安装；用户已经修改过的口令绝不覆盖。
        const usesLegacyDefault = typeof existingUser.password === 'string'
            ? await comparePassword(DEFAULT_ADMIN.password, existingUser.password)
            : false;
        if (usesLegacyDefault) {
            const password = requireStrongAdminPassword(adminPassword, allowWeak);
            updateData.password = await hashPassword(password, 12);
        }

        await prisma.user.update({
            where: { email: DEFAULT_ADMIN.email },
            data: updateData,
        });
        return { action: 'updated', email: DEFAULT_ADMIN.email };
    }

    const password = requireStrongAdminPassword(adminPassword, allowWeak);
    const hashedPassword = await hashPassword(password, 12);

    await prisma.user.create({
        data: {
            email: DEFAULT_ADMIN.email,
            password: hashedPassword,
            name: DEFAULT_ADMIN.name,
            role: DEFAULT_ADMIN.role,
            isActive: DEFAULT_ADMIN.isActive,
            educationStage: DEFAULT_ADMIN.educationStage,
            enrollmentYear: DEFAULT_ADMIN.enrollmentYear,
        },
    });

    return { action: 'created', email: DEFAULT_ADMIN.email };
}

async function main() {
    const prisma = new PrismaClient();

    try {
        const result = await seedAdmin({ prisma, hash, compare });
        if (result.action === 'created') {
            console.log('Success! Admin user created.');
            console.log(`Email: ${result.email}`);
            console.log('Admin password was read from ADMIN_PASSWORD and was not written to logs.');
        } else {
            console.log('Admin user already exists. Ensured admin role/active state.');
        }
    } finally {
        await prisma.$disconnect();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { seedAdmin, DEFAULT_ADMIN, requireStrongAdminPassword };
