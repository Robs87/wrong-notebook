const { PrismaClient } = require('@prisma/client');
const { hash } = require('bcryptjs');

const DEFAULT_ADMIN = {
    email: 'admin@localhost',
    password: '123456',
    name: 'Admin',
    role: 'admin',
    isActive: true,
    educationStage: 'junior_high',
    enrollmentYear: 2025,
};

async function seedAdmin({ prisma, hash: hashPassword }) {
    const existingUser = await prisma.user.findUnique({
        where: { email: DEFAULT_ADMIN.email },
    });

    if (existingUser) {
        await prisma.user.update({
            where: { email: DEFAULT_ADMIN.email },
            data: {
                role: DEFAULT_ADMIN.role,
                isActive: DEFAULT_ADMIN.isActive,
                educationStage: existingUser.educationStage ?? DEFAULT_ADMIN.educationStage,
                enrollmentYear: existingUser.enrollmentYear ?? DEFAULT_ADMIN.enrollmentYear,
            },
        });
        return { action: 'updated', email: DEFAULT_ADMIN.email };
    }

    const hashedPassword = await hashPassword(DEFAULT_ADMIN.password, 12);

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
        const result = await seedAdmin({ prisma, hash });
        if (result.action === 'created') {
            console.log('Success! Admin user created.');
            console.log(`Email: ${result.email}`);
            // 不向 stdout 打印口令，避免进入容器日志聚合。首次登录请使用默认口令并立即修改。
            console.log('Default password is set. Please change it immediately after first login.');
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

module.exports = { seedAdmin, DEFAULT_ADMIN };
