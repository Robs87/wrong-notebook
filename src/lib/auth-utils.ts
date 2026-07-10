import { Session } from "next-auth"

type AdminSession = Session & {
    user: NonNullable<Session["user"]> & { id: string; role: "admin" }
}

export function isAdmin(user: { role?: string } | null | undefined) {
    return user?.role === "admin"
}

export function requireAdmin(session: Session | null): session is AdminSession {
    if (!session?.user?.id || !isAdmin(session.user)) {
        return false
    }
    return true
}
