import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

const locales: Record<string, Record<string, any>> = {
    en,
    'zh-CN': zhCN,
};

let currentLang = 'en';

function detectLanguage(): string {
    const qs = new URLSearchParams(window.location.search).get('lang');
    if (qs && locales[qs]) return qs;
    const stored = localStorage.getItem('i18nLang');
    if (stored && locales[stored]) return stored;
    const nav = navigator.language;
    if (nav.startsWith('zh')) return 'zh-CN';
    return 'en';
}

export function initI18n(): void {
    currentLang = detectLanguage();
    localStorage.setItem('i18nLang', currentLang);
}

export function setLanguage(lang: string): void {
    if (locales[lang]) {
        currentLang = lang;
        localStorage.setItem('i18nLang', lang);
    }
}

export function getLanguage(): string {
    return currentLang;
}

export function t(key: string, fallback?: string): string {
    const parts = key.split('.');
    let val: any = locales[currentLang];
    for (const p of parts) {
        if (val == null || typeof val !== 'object') { val = undefined; break; }
        val = val[p];
    }
    if (typeof val === 'string') return val;
    // Fallback to English
    let enVal: any = locales.en;
    for (const p of parts) {
        if (enVal == null || typeof enVal !== 'object') { enVal = undefined; break; }
        enVal = enVal[p];
    }
    if (typeof enVal === 'string') return enVal;
    return fallback ?? key;
}
