import { describe, expect, it } from 'vitest'
import { renderChatMarkdown } from '../../app/utils/chat-markdown'

const html = (source: string) => renderChatMarkdown(source).map(block => block.content).join('')
describe('chat Markdown', () => {
  it('renders headings, emphasis, nested lists, tables, and links', () => {
    const output = html('# Architecture\n\n**API** and *worker*\n\n1. Request\n   - Validate\n\n| Layer | File |\n| --- | --- |\n| API | `server/api.ts` |\n\n[Docs](https://example.com)')
    for (const tag of ['<h1>', '<strong>', '<em>', '<ol>', '<ul>', '<table>', '<code>']) expect(output).toContain(tag)
    expect(output).toContain('href="https://example.com"')
    expect(output).toContain('rel="noopener noreferrer"')
  })
  it('highlights known languages and escapes unknown languages', () => {
    expect(html('```typescript\nconst count = 42\n```')).toContain('hljs-keyword')
    const output = html('```unknown\n<script>alert(1)</script>\n```')
    expect(output).toContain('&lt;script&gt;')
    expect(output).not.toContain('<script>')
  })
  it('preserves order around Mermaid blocks and supports multiple diagrams', () => {
    const blocks = renderChatMarkdown('Before\n\n```mermaid\nflowchart LR\n A --> B\n```\n\nBetween\n\n```mermaid\nsequenceDiagram\n A->>B: Hello\n```\n\nAfter')
    expect(blocks.map(block => block.type)).toEqual(['html', 'mermaid', 'html', 'mermaid', 'html'])
    expect(blocks[1]!.content).toContain('A --> B')
    expect(blocks[4]!.content).toContain('After')
  })
  it('does not execute raw HTML or unsafe Markdown links', () => {
    const output = html('<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n[bad](data:text/html,test)')
    expect(output).not.toContain('<img')
    expect(output).not.toContain('<script>')
    expect(output).not.toContain('href="javascript:')
    expect(output).not.toContain('href="data:')
  })
  it('leaves non-Mermaid fences as code', () => {
    expect(renderChatMarkdown('```text\nflowchart LR\n A --> B\n```').map(block => block.type)).toEqual(['html'])
  })
})
