"use client";

import { useLanguage } from "@/contexts/LanguageContext";
import { useSession } from "next-auth/react";
import { User } from "lucide-react";

export function UserWelcome() {
    const { t } = useLanguage();
    const { data: session } = useSession();

    const userName = session?.user ? (session.user.name || session.user.email) : 'User';

    return (
        <div className="flex items-center gap-2 bg-card p-4 rounded-lg border shadow-sm animate-in fade-in slide-in-from-top-4 duration-700">
            <User className="h-5 w-5 text-primary" />
            <span className="font-medium">
                {t.common.welcome || 'Welcome back, '}
                {userName}
            </span>
        </div>
    );
}
