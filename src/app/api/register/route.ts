import { NextResponse } from "next/server"
import { hash } from "bcryptjs"
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { getAppConfig } from "@/lib/config"
import { Prisma } from "@prisma/client"
import { findCaseInsensitiveUserId } from "@/lib/user-email"

const userSchema = z.object({
    // 支持标准邮箱和本地邮箱（如 user@localhost）
    email: z.string()
        .trim()
        .max(254)
        .regex(/^[^\s@]+@[^\s@]+$/, "Invalid email format")
        .transform(value => value.toLowerCase()),
    password: z.string().min(8).max(128),
    name: z.string().trim().min(1).max(100),
    educationStage: z.enum(['primary', 'junior_high', 'senior_high', 'university']).optional(),
    enrollmentYear: z.number().int().min(1900).max(2100).optional(),
})

export async function POST(req: Request) {
    try {
        // 检查是否允许注册
        const config = getAppConfig();
        if (config.allowRegistration !== true) {
            return NextResponse.json(
                { user: null, message: "Registration is currently disabled" },
                { status: 403 }
            );
        }

        const body = await req.json()
        const { email, password, name, educationStage, enrollmentYear } = userSchema.parse(body)

        const existingUser = await prisma.user.findUnique({
            where: { email }
        })

        if (existingUser || await findCaseInsensitiveUserId(email)) {
            return NextResponse.json(
                { user: null, message: "User with this email already exists" },
                { status: 409 }
            )
        }

        const hashedPassword = await hash(password, 12)
        const newUser = await prisma.user.create({
            data: {
                email,
                name,
                password: hashedPassword,
                educationStage,
                enrollmentYear
            }
        })

        const rest = Object.fromEntries(
            Object.entries(newUser).filter(([key]) => key !== 'password')
        )

        return NextResponse.json(
            { user: rest, message: "User created successfully" },
            { status: 201 }
        )
    } catch (error) {
        if (error instanceof z.ZodError || error instanceof SyntaxError) {
            return NextResponse.json(
                { user: null, message: "Invalid registration data" },
                { status: 400 }
            )
        }
        // 防止“先查后建”的并发竞争把唯一键冲突误报成 500。
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            return NextResponse.json(
                { user: null, message: "User with this email already exists" },
                { status: 409 }
            )
        }
        return NextResponse.json(
            { user: null, message: "Something went wrong" },
            { status: 500 }
        )
    }
}
