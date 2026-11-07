import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/common'

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(source, language) {
    if (language && hljs.getLanguage(language)) {
      try { return hljs.highlight(source, { language, ignoreIllegals: true }).value } catch { /* escape below */ }
    }
    return ''
  },
})
const renderLink = markdown.renderer.rules.link_open
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index]!.attrSet('target', '_blank')
  tokens[index]!.attrSet('rel', 'noopener noreferrer')
  return renderLink ? renderLink(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options)
}

export type ChatMarkdownBlock = { type: 'html' | 'mermaid', content: string }

/** Raw HTML stays escaped; only Markdown-generated markup reaches the renderer. */
export function renderChatMarkdown(source: string): ChatMarkdownBlock[] {
  const tokens = markdown.parse(source, {})
  const blocks: ChatMarkdownBlock[] = []
  let start = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.type !== 'fence' || token.level !== 0 || token.info.trim().toLowerCase() !== 'mermaid') continue
    if (i > start) blocks.push({ type: 'html', content: markdown.renderer.render(tokens.slice(start, i), markdown.options, {}) })
    blocks.push({ type: 'mermaid', content: token.content })
    start = i + 1
  }
  if (start < tokens.length) blocks.push({ type: 'html', content: markdown.renderer.render(tokens.slice(start), markdown.options, {}) })
  return blocks
}
