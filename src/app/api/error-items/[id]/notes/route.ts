import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, forbidden, notFound, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:error-items:notes');

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    try {
        // 优先用 JWT 里可信的 user.id，避免按 email 二次查询（email 可能已变）
        const userId = session?.user?.id;
        if (!userId) {
            return unauthorized("Authentication required");
        }

        // 对象级授权：先查归属，再更新。防止 IDOR 越权改他人笔记。
        const existing = await prisma.errorItem.findUnique({
            where: { id },
            select: { userId: true },
        });
        if (!existing) {
            return notFound("Item not found");
        }
        if (existing.userId !== userId) {
            return forbidden("Not authorized to update this item");
        }

        const { userNotes } = await req.json();

        const errorItem = await prisma.errorItem.update({
            where: { id },
            data: {
                userNotes: userNotes,
            },
        });

        return NextResponse.json(errorItem);
    } catch (error) {
        logger.error({ error }, 'Error updating notes');
        return internalError("Failed to update notes");
    }
}
