import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
    const email = 'admin@localhost';
    const defaultPassword = '123456';
    const name = 'Admin';

    console.log(`Checking admin user: ${email}...`);

    const existingUser = await prisma.user.findUnique({
        where: { email },
    });

    if (existingUser) {
        // 仅在用户缺失关键字段时补齐，绝不覆盖用户已主动修改的属性（教育阶段、口令等），
        // 避免每次容器重启都把 admin 配置重置回默认值。
        console.log(`Admin user already exists, leaving user-managed fields untouched.`);
        return;
    }

    console.log(`Admin user not found. Creating...`);
    const hashedPassword = await hash(defaultPassword, 12);

    const user = await prisma.user.create({
        data: {
            email,
            password: hashedPassword,
            name,
            role: 'admin',
            isActive: true,
            educationStage: 'junior_high',
            enrollmentYear: 2025,
        },
    });

    // 仅提示账号创建成功，不向 stdout 打印口令（防止口令进入容器日志聚合）
    console.log(`\nSuccess! Admin user created.`);
    console.log(`Email: ${user.email}`);
    console.log(`Default password has been set. Please change it immediately after first login.`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
