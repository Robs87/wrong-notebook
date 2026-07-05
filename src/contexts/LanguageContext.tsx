"use client";

import React, { createContext, useContext, useSyncExternalStore } from 'react';
import { translations, Language } from '@/lib/translations';

interface LanguageContextType {
    language: Language;
    setLanguage: (lang: Language) => void;
    t: typeof translations['en'];
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);
const DEFAULT_LANGUAGE: Language = 'zh';
const LANGUAGE_STORAGE_KEY = 'app-language';

function isLanguage(value: string | null): value is Language {
    return value === 'zh' || value === 'en';
}

function getStoredLanguage(): Language {
    if (typeof window === 'undefined') return DEFAULT_LANGUAGE;

    const savedLang = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(savedLang) ? savedLang : DEFAULT_LANGUAGE;
}

function subscribeToLanguageChange(onStoreChange: () => void) {
    if (typeof window === 'undefined') return () => undefined;

    const handleStorage = (event: StorageEvent) => {
        if (event.key === LANGUAGE_STORAGE_KEY) {
            onStoreChange();
        }
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener('app-language-change', onStoreChange);

    return () => {
        window.removeEventListener('storage', handleStorage);
        window.removeEventListener('app-language-change', onStoreChange);
    };
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
    const language = useSyncExternalStore(subscribeToLanguageChange, getStoredLanguage, () => DEFAULT_LANGUAGE);

    const handleSetLanguage = (lang: Language) => {
        localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
        window.dispatchEvent(new Event('app-language-change'));
    };

    const value = {
        language,
        setLanguage: handleSetLanguage,
        t: translations[language],
    };

    return (
        <LanguageContext.Provider value={value}>
            {children}
        </LanguageContext.Provider>
    );
}

export function useLanguage() {
    const context = useContext(LanguageContext);
    if (context === undefined) {
        throw new Error('useLanguage must be used within a LanguageProvider');
    }
    return context;
}
