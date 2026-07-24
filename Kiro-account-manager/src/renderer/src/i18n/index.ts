/**
 * internationalization (i18n) system
 * Supports Chinese and English bilingual, expandable local translation files
 */

import { create } from 'zustand'
import en from './locales/en'
import zh from './locales/zh'

export type Language = 'en' | 'zh' | 'auto'

export interface Translations {
  [key: string]: string | Translations
}

// Built-in translation
const builtInLocales: Record<string, Translations> = {
  en,
  zh
}

// Custom translation (loaded from local file)
let customLocales: Record<string, Translations> = {}

/**
 * Get the value of a nested object
 */
function getNestedValue(obj: Translations, path: string): string {
  const keys = path.split('.')
  let current: Translations | string = obj
  
  for (const key of keys) {
    if (typeof current === 'string') return path
    if (current[key] === undefined) return path
    current = current[key]
  }
  
  return typeof current === 'string' ? current : path
}

/**
 * Detection system language
 */
export function detectSystemLanguage(): 'en' | 'zh' {
  const lang = navigator.language.toLowerCase()
  if (lang.startsWith('zh')) return 'zh'
  return 'en'
}

/**
 * Get the actual language used
 */
export function getActualLanguage(language: Language): 'en' | 'zh' {
  if (language === 'auto') {
    return detectSystemLanguage()
  }
  return language
}

/**
 * translation function
 */
export function translate(key: string, language: 'en' | 'zh', params?: Record<string, string | number>): string {
  // Prioritize custom translations
  let text = getNestedValue(customLocales[language] || {}, key)
  
  // If custom translation is not available, use built-in translation
  if (text === key) {
    text = getNestedValue(builtInLocales[language] || builtInLocales.en, key)
  }
  
  // Replace parameters
  if (params && text !== key) {
    Object.entries(params).forEach(([paramKey, value]) => {
      text = text.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(value))
    })
  }
  
  return text
}

/**
 * Load custom translation files
 */
export async function loadCustomLocale(language: string, translations: Translations): Promise<void> {
  customLocales[language] = translations
}

/**
 * Clear custom translation
 */
export function clearCustomLocales(): void {
  customLocales = {}
}

/**
 * i18n Store
 */
interface I18nState {
  language: Language
  actualLanguage: 'en' | 'zh'
  setLanguage: (language: Language) => void
  t: (key: string, params?: Record<string, string | number>) => string
}

export const useI18n = create<I18nState>((set, get) => ({
  language: 'auto',
  actualLanguage: detectSystemLanguage(),
  
  setLanguage: (language: Language) => {
    const actualLanguage = getActualLanguage(language)
    set({ language, actualLanguage })
  },
  
  t: (key: string, params?: Record<string, string | number>) => {
    const { actualLanguage } = get()
    return translate(key, actualLanguage, params)
  }
}))

export default useI18n
