import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, badRequest } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { z } from "zod";

const logger = createLogger('api:error-items:mastery');

// masteryLevel 语义范围 0-2：0 未掌握 / 1 复习中 / 2 已掌握
const masterySchema = z.object({
    masteryLevel: z.number().int().min(0).max(2),
});

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    try {
        const userId = session?.user?.id;
        if (!userId) {
            return unauthorized("Authentication required");
        }

        const body = await req.json();
        const parsed = masterySchema.safeParse(body);
        if (!parsed.success) {
            return badRequest("masteryLevel must be an integer between 0 and 2");
        }
        const { masteryLevel } = parsed.data;

        // Verify ownership before update
        const existingItem = await prisma.errorItem.findUnique({
            where: { id },
            select: { userId: true },
        });

        if (!existingItem) {
            return NextResponse.json({ message: "Item not found" }, { status: 404 });
        }

        if (existingItem.userId !== userId) {
            return NextResponse.json({ message: "Not authorized to update this item" }, { status: 403 });
        }

        const errorItem = await prisma.errorItem.update({
            where: {
                id,
            },
            data: {
                masteryLevel,
            },
        });

        return NextResponse.json(errorItem);
    } catch (error) {
        logger.error({ error }, 'Error updating item');
        return internalError("Failed to update error item");
    }
}
