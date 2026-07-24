/**
 * Steering File loader: reading workspace .kiro/steering/*.md and parsed into injectable rule text.
 *
 * Steering Files support three inclusion modes (via YAML frontmatter specified):
 *   - always(default)- Injected on every request
 *   - fileMatch — When a request involves matching fileMatchPattern injected into the file
 *   - manual — Only injected when explicitly referenced by the user (anti-generation is skipped by default)
 */
import * as fs from 'fs'
import * as path from 'path'

export interface SteeringDocument {
  /** File name (without path) */
  name: string
  /** frontmatter Specified include pattern */
  inclusion: 'always' | 'fileMatch' | 'manual'
  /** fileMatch match in pattern glob */
  fileMatchPattern?: string
  /** Text content (remove frontmatter back) */
  content: string
}

/**
 * Load all from workspace path steering document.
 * return press inclusion Classified document list (always priority).
 */
export function loadSteeringDocuments(workspacePath: string): SteeringDocument[] {
  const steeringDir = path.join(workspacePath, '.kiro', 'steering')
  if (!fs.existsSync(steeringDir)) return []

  const files = fs.readdirSync(steeringDir).filter(f => f.endsWith('.md'))
  const docs: SteeringDocument[] = []

  for (const file of files) {
    try {
      const fullPath = path.join(steeringDir, file)
      const raw = fs.readFileSync(fullPath, 'utf-8')
      const { frontmatter, content } = parseFrontmatter(raw)

      docs.push({
        name: file,
        inclusion: (frontmatter.inclusion as SteeringDocument['inclusion']) || 'always',
        fileMatchPattern: frontmatter.fileMatchPattern as string | undefined,
        content: content.trim()
      })
    } catch (e) {
      console.warn(`[Steering] Failed to read ${file}:`, e)
    }
  }

  // always front of the line
  docs.sort((a, b) => {
    if (a.inclusion === 'always' && b.inclusion !== 'always') return -1
    if (a.inclusion !== 'always' && b.inclusion === 'always') return 1
    return 0
  })

  return docs
}

/**
 * Will steering The document list is formatted to be injected into system prompt text.
 * Contains only inclusion=always Documentation (reverse generation does not have file context Information, unable to judge fileMatch）。
 */
export function formatSteeringForPrompt(docs: SteeringDocument[]): string {
  const alwaysDocs = docs.filter(d => d.inclusion === 'always')
  if (alwaysDocs.length === 0) return ''

  const parts = alwaysDocs.map(d => `<!-- steering: ${d.name} -->\n${d.content}`)
  return `<steering-files>\n${parts.join('\n\n')}\n</steering-files>`
}

/**
 * Simple analysis YAML frontmatter（--- separated key: value piece).
 */
function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; content: string } {
  const frontmatter: Record<string, string> = {}

  if (!raw.startsWith('---')) {
    return { frontmatter, content: raw }
  }

  const endIdx = raw.indexOf('\n---', 3)
  if (endIdx === -1) {
    return { frontmatter, content: raw }
  }

  const fmBlock = raw.slice(4, endIdx)
  const content = raw.slice(endIdx + 4)

  for (const line of fmBlock.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '')
      if (key && value) frontmatter[key] = value
    }
  }

  return { frontmatter, content }
}
