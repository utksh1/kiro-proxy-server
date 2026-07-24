/**
 * useTranslation hook
 * simplify i18n used React hook
 */

import { useMemo } from 'react'
import { useAccountsStore } from '@/store/accounts'
import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'

type Language = 'auto' | 'en' | 'zh'

interface Translations {
  [key: string]: string | Translations
}

const locales: Record<string, Translations> = { en, zh }

/**
 * Detection system language
 */
function detectSystemLanguage(): 'en' | 'zh' {
  const lang = navigator.language.toLowerCase()
  if (lang.startsWith('zh')) return 'zh'
  return 'en'
}

/**
 * Get the actual language used
 */
function getActualLanguage(language: Language): 'en' | 'zh' {
  if (language === 'auto') {
    return detectSystemLanguage()
  }
  return language
}

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
 * translation function
 */
function translate(key: string, language: 'en' | 'zh', params?: Record<string, string | number>): string {
  let text = getNestedValue(locales[language] || locales.en, key)
  
  // Replace parameters
  if (params && text !== key) {
    Object.entries(params).forEach(([paramKey, value]) => {
      text = text.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(value))
    })
  }
  
  return text
}

/**
 * useTranslation hook
 * @returns { t, language, actualLanguage }
 */
export function useTranslation() {
  const language = useAccountsStore((state) => state.language)
  
  const actualLanguage = useMemo(() => getActualLanguage(language), [language])
  
  const t = useMemo(() => {
    return (key: string, params?: Record<string, string | number>) => {
      return translate(key, actualLanguage, params)
    }
  }, [actualLanguage])
  
  return {
    t,
    language,
    actualLanguage
  }
}

export default useTranslation
